/*
  automation.cpp

  This file is part of GammaRay, the Qt application inspection and manipulation tool.

  SPDX-FileCopyrightText: 2026 Klarälvdalens Datakonsult AB, a KDAB Group company <info@kdab.com>

  SPDX-License-Identifier: GPL-2.0-or-later

  Contact KDAB at <info@kdab.com> for commercial licensing options.
*/

#include "automation.h"
#include "automationelement.h"
#include "automationinput.h"
#include "automationrecorder.h"
#include "automationselector.h"

#include <core/probe.h>
#include <core/probeguard.h>
#include <core/probesettings.h>

#include <QBuffer>
#include <QCoreApplication>
#include <QDir>
#include <QFile>
#include <QGuiApplication>
#include <QHostAddress>
#include <QJsonArray>
#include <QJsonDocument>
#include <QMetaMethod>
#include <QMutexLocker>
#include <QSaveFile>
#include <QWebSocket>
#include <QWebSocketServer>
#include <QWindow>

#include <iostream>

using namespace GammaRay;
using namespace GammaRay::Automation;

namespace GammaRay {
namespace Automation {

enum ErrorCode
{
    ParseError = -32700,
    InvalidRequest = -32600,
    MethodNotFound = -32601,
    InvalidParams = -32602,
    StaleHandle = 1001,
    NotFound = 1002,
    Timeout = 1003,
    NotActionable = 1004,
    Failed = 1005,
    InvalidSelector = 1006
};

static const int ProtocolVersion = 1;

/*! A pending JSON-RPC response; may be completed asynchronously, exactly once. */
class Reply
{
public:
    Reply(QWebSocket *socket, QJsonValue id)
        : m_socket(socket)
        , m_id(std::move(id))
    {
    }

    void ok(const QJsonValue &result = QJsonObject())
    {
        send(QJsonObject { { QStringLiteral("result"), result } });
    }

    void fail(int code, const QString &message, const QJsonValue &data = QJsonValue())
    {
        QJsonObject error { { QStringLiteral("code"), code }, { QStringLiteral("message"), message } };
        if (!data.isUndefined() && !data.isNull())
            error.insert(QStringLiteral("data"), data);
        send(QJsonObject { { QStringLiteral("error"), error } });
    }

    bool isDone() const
    {
        return m_done;
    }

private:
    void send(QJsonObject msg)
    {
        if (m_done)
            return;
        m_done = true;
        if (!m_socket || m_id.isUndefined() || m_id.isNull())
            return; // notification, or client gone
        msg.insert(QStringLiteral("jsonrpc"), QStringLiteral("2.0"));
        msg.insert(QStringLiteral("id"), m_id);
        m_socket->sendTextMessage(QString::fromUtf8(QJsonDocument(msg).toJson(QJsonDocument::Compact)));
    }

    QPointer<QWebSocket> m_socket;
    QJsonValue m_id;
    bool m_done = false;
};

/*!
 * Connects to an arbitrary signal (by QMetaMethod) and forwards emissions with their
 * arguments, like QSignalSpy does, without depending on Qt Test.
 */
class SignalRelay : public QObject
{
public:
    using Callback = std::function<void(const QVariantList &)>;

    SignalRelay(QObject *sender, const QMetaMethod &signal, Callback callback, QObject *parent)
        : QObject(parent)
        , m_signal(signal)
        , m_callback(std::move(callback))
    {
        // no Q_OBJECT: our single virtual slot lives right after QObject's own methods
        m_connected = QMetaObject::connect(sender, signal.methodIndex(), this,
                                           QObject::staticMetaObject.methodCount(), Qt::DirectConnection);
    }

    bool isConnected() const
    {
        return m_connected;
    }

    int qt_metacall(QMetaObject::Call call, int id, void **a) override
    {
        id = QObject::qt_metacall(call, id, a);
        if (id < 0)
            return id;
        if (call == QMetaObject::InvokeMetaMethod) {
            if (id == 0) {
                QVariantList args;
                for (int i = 0; i < m_signal.parameterCount(); ++i) {
                    const QMetaType mt = m_signal.parameterMetaType(i);
                    if (mt == QMetaType::fromType<QVariant>())
                        args.push_back(*reinterpret_cast<QVariant *>(a[i + 1]));
                    else if (mt.isValid())
                        args.push_back(QVariant(mt, a[i + 1]));
                    else
                        args.push_back(QVariant());
                }
                if (m_callback)
                    m_callback(args);
            }
            --id;
        }
        return id;
    }

private:
    QMetaMethod m_signal;
    Callback m_callback;
    bool m_connected = false;
};

}
}

static QJsonObject rectToJson(const QRectF &r)
{
    return QJsonObject { { QStringLiteral("x"), r.x() },
                         { QStringLiteral("y"), r.y() },
                         { QStringLiteral("width"), r.width() },
                         { QStringLiteral("height"), r.height() } };
}

AutomationServer::AutomationServer(Probe *probe, QObject *parent)
    : QObject(parent)
    , m_probe(probe)
    , m_input(new InputQueue(this))
{
    m_mapper.toJson = [this](QObject *obj) { return objectToJson(obj); };
    m_mapper.fromJson = [this](const QJsonValue &v) {
        return m_handles.object(static_cast<qint64>(v.toObject().value(QStringLiteral("handle")).toDouble()));
    };
    m_engine.reset(new SelectorEngine([this]() { return roots(); }, [this](QObject *obj) { return accept(obj); }));

    m_eventFlushTimer.setSingleShot(true);
    m_eventFlushTimer.setInterval(0);
    connect(&m_eventFlushTimer, &QTimer::timeout, this, &AutomationServer::flushObjectEvents);

    connect(probe, &Probe::objectCreated, this, &AutomationServer::objectCreated);
    connect(probe, &Probe::objectDestroyed, this, &AutomationServer::objectDestroyed);

    registerHandlers();
    listen();
}

AutomationServer::~AutomationServer()
{
    if (!m_portFile.isEmpty())
        QFile::remove(m_portFile);
}

void AutomationServer::listen()
{
    // opt-in: GAMMARAY_AUTOMATION_PORT=<port|0>, or probe setting AutomationPort
    bool ok = false;
    int port = qEnvironmentVariableIntValue("GAMMARAY_AUTOMATION_PORT", &ok);
    if (!ok) {
        port = ProbeSettings::value(QStringLiteral("AutomationPort"), -1).toInt();
        ok = port >= 0;
    }
    if (!ok)
        return;

    QString address = qEnvironmentVariable("GAMMARAY_AUTOMATION_ADDRESS");
    if (address.isEmpty())
        address = ProbeSettings::value(QStringLiteral("AutomationAddress"), QStringLiteral("127.0.0.1")).toString();

    ProbeGuard guard;
    m_server = new QWebSocketServer(QStringLiteral("GammaRay Automation"), QWebSocketServer::NonSecureMode, this);
    connect(m_server, &QWebSocketServer::newConnection, this, &AutomationServer::newConnection);
    if (!m_server->listen(QHostAddress(address), quint16(port))) {
        std::cerr << "GammaRay automation server failed to listen on " << qPrintable(address) << ':' << port
                  << ": " << qPrintable(m_server->errorString()) << std::endl;
        return;
    }

    const QString url = QStringLiteral("ws://%1:%2").arg(address).arg(m_server->serverPort());
    std::cout << "GammaRay automation server listening on " << qPrintable(url) << std::endl;

    m_portFile = qEnvironmentVariable("GAMMARAY_AUTOMATION_PORT_FILE");
    if (m_portFile.isEmpty())
        m_portFile = QDir::temp().filePath(QStringLiteral("gammaray-automation-%1.json").arg(QCoreApplication::applicationPid()));
    QSaveFile f(m_portFile);
    if (f.open(QIODevice::WriteOnly)) {
        const QJsonObject info { { QStringLiteral("url"), url },
                                 { QStringLiteral("port"), int(m_server->serverPort()) },
                                 { QStringLiteral("pid"), QCoreApplication::applicationPid() } };
        f.write(QJsonDocument(info).toJson(QJsonDocument::Compact));
        f.commit();
    }
}

void AutomationServer::newConnection()
{
    while (m_server->hasPendingConnections()) {
        ProbeGuard guard;
        QWebSocket *socket = m_server->nextPendingConnection();
        socket->setParent(this);
        m_sessions.insert(socket, Session());
        connect(socket, &QWebSocket::textMessageReceived, this,
                [this, socket](const QString &msg) { textMessageReceived(socket, msg); });
        connect(socket, &QWebSocket::disconnected, this, [this, socket]() { socketDisconnected(socket); });
    }
}

void AutomationServer::socketDisconnected(QWebSocket *socket)
{
    const auto session = m_sessions.take(socket);
    for (const auto &spy : session.spies)
        delete spy.relay;
    qDeleteAll(session.recorders);
    socket->deleteLater();
}

void AutomationServer::textMessageReceived(QWebSocket *socket, const QString &message)
{
    QJsonParseError parseError;
    const auto doc = QJsonDocument::fromJson(message.toUtf8(), &parseError);
    if (doc.isNull() || !doc.isObject()) {
        Reply(socket, 0).fail(ParseError, parseError.errorString());
        return;
    }
    const QJsonObject req = doc.object();
    auto reply = std::make_shared<Reply>(socket, req.value(QStringLiteral("id")));
    const QString method = req.value(QStringLiteral("method")).toString();
    const auto it = m_handlers.constFind(method);
    if (it == m_handlers.constEnd()) {
        reply->fail(MethodNotFound, QStringLiteral("unknown method '%1'").arg(method));
        return;
    }
    const QJsonObject params = req.value(QStringLiteral("params")).toObject();
    it.value()(socket, params, reply);
}

QObject *AutomationServer::resolve(const QJsonObject &params, const ReplyPtr &reply, const QString &key)
{
    const QJsonValue v = params.value(key);
    if (!v.isDouble()) {
        reply->fail(InvalidParams, QStringLiteral("missing '%1' parameter").arg(key));
        return nullptr;
    }
    QObject *obj = m_handles.object(static_cast<qint64>(v.toDouble()));
    if (!obj)
        reply->fail(StaleHandle, QStringLiteral("element %1 no longer exists").arg(static_cast<qint64>(v.toDouble())));
    return obj;
}

QJsonValue AutomationServer::objectToJson(QObject *obj)
{
    if (!obj)
        return QJsonValue::Null;
    QJsonObject o { { QStringLiteral("handle"), double(m_handles.handleFor(obj)) },
                    { QStringLiteral("type"), Element::displayTypeName(obj) } };
    if (!obj->objectName().isEmpty())
        o.insert(QStringLiteral("objectName"), obj->objectName());
    const QString id = Element::qmlId(obj);
    if (!id.isEmpty())
        o.insert(QStringLiteral("id"), id);
    return o;
}

QJsonObject AutomationServer::describe(QObject *obj)
{
    QJsonObject o = objectToJson(obj).toObject();
    o.insert(QStringLiteral("className"), QString::fromLatin1(obj->metaObject()->className()));
    o.insert(QStringLiteral("typeNames"), QJsonArray::fromStringList(Element::typeNames(obj)));
    if (Element::hasText(obj))
        o.insert(QStringLiteral("text"), Element::text(obj));
    o.insert(QStringLiteral("visible"), Element::isVisible(obj));
    o.insert(QStringLiteral("enabled"), Element::isEnabled(obj));
    if (Element::hasGeometry(obj))
        o.insert(QStringLiteral("geometry"), rectToJson(Element::globalGeometry(obj)));
    return o;
}

bool AutomationServer::accept(QObject *obj) const
{
    // only main-thread objects tracked by the probe (excludes GammaRay's own objects)
    return obj->thread() == thread() && m_probe->isValidObject(obj);
}

QVector<QObject *> AutomationServer::allObjects() const
{
    QVector<QObject *> result;
    const auto &objs = m_probe->allQObjects();
    result.reserve(objs.size());
    for (QObject *obj : objs) {
        if (accept(obj))
            result.push_back(obj);
    }
    return result;
}

QVector<QObject *> AutomationServer::roots() const
{
    QVector<QObject *> result;
    // windows first, so document order roughly follows what the user sees
    const auto windows = Element::topLevelWindows();
    for (QObject *w : windows) {
        if (accept(w))
            result.push_back(w);
    }
    const auto objs = allObjects();
    for (QObject *obj : objs) {
        if (obj->parent())
            continue;
        if (obj->inherits("QQuickItem") && obj->property("parent").value<QObject *>())
            continue; // reached through its visual parent
        if (!result.contains(obj))
            result.push_back(obj);
    }
    return result;
}

QPointF AutomationServer::positionParam(QObject *obj, const QJsonObject &params, const QString &key) const
{
    const QJsonValue p = params.value(key);
    if (p.isObject()) {
        const auto o = p.toObject();
        return QPointF(o.value(QStringLiteral("x")).toDouble(), o.value(QStringLiteral("y")).toDouble());
    }
    return Element::defaultClickPosition(obj);
}

void AutomationServer::objectCreated(QObject *obj)
{
    bool wanted = false;
    for (const auto &s : std::as_const(m_sessions))
        wanted |= s.objectCreatedEvents;
    if (!wanted || obj->thread() != thread())
        return;
    m_pendingCreated.push_back(objectToJson(obj));
    if (!m_eventFlushTimer.isActive())
        m_eventFlushTimer.start();
}

void AutomationServer::objectDestroyed(QObject *obj)
{
    // obj is dangling here, only use it as a key
    const qint64 handle = m_handles.objectDestroyed(obj);
    if (!handle)
        return;
    bool wanted = false;
    for (const auto &s : std::as_const(m_sessions))
        wanted |= s.objectDestroyedEvents;
    if (!wanted)
        return;
    m_pendingDestroyed.push_back(double(handle));
    if (!m_eventFlushTimer.isActive())
        m_eventFlushTimer.start();
}

void AutomationServer::flushObjectEvents()
{
    if (!m_pendingCreated.isEmpty()) {
        broadcast(QStringLiteral("objectsCreated"), QJsonObject { { QStringLiteral("elements"), m_pendingCreated } },
                  &Session::objectCreatedEvents);
        m_pendingCreated = QJsonArray();
    }
    if (!m_pendingDestroyed.isEmpty()) {
        broadcast(QStringLiteral("objectsDestroyed"), QJsonObject { { QStringLiteral("handles"), m_pendingDestroyed } },
                  &Session::objectDestroyedEvents);
        m_pendingDestroyed = QJsonArray();
    }
}

void AutomationServer::broadcast(const QString &method, const QJsonObject &params, bool Session::*filter)
{
    const QJsonObject msg { { QStringLiteral("jsonrpc"), QStringLiteral("2.0") },
                            { QStringLiteral("method"), method },
                            { QStringLiteral("params"), params } };
    const QString text = QString::fromUtf8(QJsonDocument(msg).toJson(QJsonDocument::Compact));
    for (auto it = m_sessions.begin(); it != m_sessions.end(); ++it) {
        if (it.value().*filter)
            it.key()->sendTextMessage(text);
    }
}

// --- input -----------------------------------------------------------------------

namespace {
struct ClickOptions
{
    Qt::MouseButton button = Qt::LeftButton;
    Qt::KeyboardModifiers modifiers;
};

bool parseClickOptions(const QJsonObject &params, ClickOptions *opts, QString *error)
{
    bool ok = false;
    opts->button = Input::parseButton(params.value(QStringLiteral("button")).toString(), &ok);
    if (!ok) {
        *error = QStringLiteral("invalid mouse button");
        return false;
    }
    QStringList mods;
    const auto arr = params.value(QStringLiteral("modifiers")).toArray();
    for (const auto &m : arr)
        mods.push_back(m.toString());
    opts->modifiers = Input::parseModifiers(mods, &ok);
    if (!ok) {
        *error = QStringLiteral("invalid modifier in %1").arg(mods.join(QLatin1Char(',')));
        return false;
    }
    return true;
}
}

void AutomationServer::enqueueClick(QObject *target, const QJsonObject &params, int clickCount, const ReplyPtr &reply)
{
    ClickOptions opts;
    QString error;
    if (!parseClickOptions(params, &opts, &error)) {
        reply->fail(InvalidParams, error);
        return;
    }
    const QPointer<QObject> obj(target);
    const QPointF local = positionParam(target, params);
    auto window = std::make_shared<QPointer<QWindow>>();
    auto pos = std::make_shared<QPointF>();

    // resolve the window position when the action actually starts (the element may have moved)
    m_input->enqueue([=]() {
        if (!obj) {
            reply->fail(StaleHandle, QStringLiteral("element was destroyed before it could be clicked"));
            return;
        }
        QString err;
        const auto t = Element::inputTarget(obj, local, &err);
        if (!t.window) {
            reply->fail(NotActionable, err);
            return;
        }
        *window = t.window;
        *pos = t.windowPos;
        Input::mouseMove(t.window, t.windowPos, opts.modifiers);
    });
    for (int i = 0; i < clickCount; ++i) {
        const bool last = i == clickCount - 1;
        m_input->enqueue([=]() {
            if (!reply->isDone() && *window)
                Input::mousePress(*window, *pos, opts.button, opts.modifiers);
        });
        m_input->enqueue([=]() {
            if (reply->isDone())
                return;
            // reply first: the release may open a modal dialog (nested event loop).
            // The window may be gone already if the press closed it; still release the button.
            if (last)
                reply->ok();
            Input::mouseRelease(*window, *pos, opts.button, opts.modifiers, last);
        });
    }
}

void AutomationServer::enqueueTyping(QObject *target, const QString &text, bool clearFirst, const ReplyPtr &reply)
{
    const QPointer<QObject> obj(target);
    auto window = std::make_shared<QPointer<QWindow>>();

    m_input->enqueue([=]() {
        QString err;
        if (obj) {
            if (!Element::focus(obj, &err)) {
                reply->fail(NotActionable, err);
                return;
            }
            *window = Element::inputTarget(obj, QPointF(), &err).window;
        } else if (target) {
            reply->fail(StaleHandle, QStringLiteral("element was destroyed before typing"));
            return;
        } else {
            *window = QGuiApplication::focusWindow();
        }
        if (!*window)
            reply->fail(NotActionable, QStringLiteral("no window to send keyboard input to"));
    });

    auto keyStep = [=](const Input::KeySpec &k, bool lastStep) {
        m_input->enqueue([=]() {
            if (!reply->isDone() && *window)
                Input::keyPress(*window, k.key, k.modifiers, k.text);
        });
        m_input->enqueue([=]() {
            if (reply->isDone())
                return;
            if (lastStep)
                reply->ok();
            Input::keyRelease(*window, k.key, k.modifiers, k.text);
        });
    };

    if (clearFirst) {
        Input::KeySpec selectAll;
        QString err;
        Input::parseKey(QStringLiteral("Control+A"), &selectAll, &err);
        keyStep(selectAll, false);
        Input::KeySpec backspace;
        Input::parseKey(QStringLiteral("Backspace"), &backspace, &err);
        keyStep(backspace, text.isEmpty());
    }
    for (int i = 0; i < text.size(); ++i)
        keyStep(Input::keyForCharacter(text.at(i)), i == text.size() - 1);
    if (!clearFirst && text.isEmpty())
        m_input->enqueue([=]() { reply->ok(); });
}

// --- API -------------------------------------------------------------------------

void AutomationServer::registerHandlers()
{
    auto &h = m_handlers;

    h[QStringLiteral("hello")] = [](QWebSocket *, const QJsonObject &, const ReplyPtr &reply) {
        reply->ok(QJsonObject { { QStringLiteral("protocolVersion"), ProtocolVersion },
                                { QStringLiteral("pid"), QCoreApplication::applicationPid() },
                                { QStringLiteral("appName"), QCoreApplication::applicationName() },
                                { QStringLiteral("qtVersion"), QString::fromLatin1(qVersion()) },
                                { QStringLiteral("platform"), QGuiApplication::platformName() } });
    };

    h[QStringLiteral("query")] = [this](QWebSocket *, const QJsonObject &params, const ReplyPtr &reply) {
        QString error;
        const Selector sel = Selector::parse(params.value(QStringLiteral("selector")).toString(), &error);
        if (!sel.isValid()) {
            reply->fail(InvalidSelector, error);
            return;
        }
        QObject *scope = nullptr;
        if (params.contains(QStringLiteral("scope"))) {
            scope = resolve(params, reply, QStringLiteral("scope"));
            if (!scope)
                return;
        }
        QVector<QObject *> matches;
        {
            QMutexLocker lock(Probe::objectLock());
            matches = m_engine->query(sel, scope);
        }
        QJsonArray arr;
        for (QObject *obj : std::as_const(matches))
            arr.push_back(params.value(QStringLiteral("describe")).toBool() ? QJsonValue(describe(obj)) : objectToJson(obj));
        reply->ok(QJsonObject { { QStringLiteral("elements"), arr } });
    };

    h[QStringLiteral("windows")] = [this](QWebSocket *, const QJsonObject &, const ReplyPtr &reply) {
        QJsonArray arr;
        const auto windows = Element::topLevelWindows();
        for (QObject *w : windows)
            arr.push_back(describe(w));
        reply->ok(QJsonObject { { QStringLiteral("elements"), arr } });
    };

    h[QStringLiteral("describe")] = [this](QWebSocket *, const QJsonObject &params, const ReplyPtr &reply) {
        if (QObject *obj = resolve(params, reply))
            reply->ok(describe(obj));
    };

    // non-throwing state probe used by the client's auto-waiting
    h[QStringLiteral("actionability")] = [this](QWebSocket *, const QJsonObject &params, const ReplyPtr &reply) {
        QObject *obj = m_handles.object(static_cast<qint64>(params.value(QStringLiteral("handle")).toDouble()));
        if (!obj) {
            reply->ok(QJsonObject { { QStringLiteral("attached"), false } });
            return;
        }
        QJsonObject r { { QStringLiteral("attached"), true },
                        { QStringLiteral("visible"), Element::isVisible(obj) },
                        { QStringLiteral("enabled"), Element::isEnabled(obj) },
                        { QStringLiteral("hasGeometry"), Element::hasGeometry(obj) } };
        if (Element::hasGeometry(obj)) {
            r.insert(QStringLiteral("geometry"), rectToJson(Element::globalGeometry(obj)));
            if (params.value(QStringLiteral("checkHitTarget")).toBool(true) && Element::isVisible(obj)) {
                QString blocker;
                {
                    QMutexLocker lock(Probe::objectLock());
                    blocker = Element::blockedBy(obj, positionParam(obj, params), allObjects());
                }
                if (!blocker.isEmpty())
                    r.insert(QStringLiteral("blockedBy"), blocker);
            }
        }
        reply->ok(r);
    };

    h[QStringLiteral("getProperty")] = [this](QWebSocket *, const QJsonObject &params, const ReplyPtr &reply) {
        QObject *obj = resolve(params, reply);
        if (!obj)
            return;
        const QString name = params.value(QStringLiteral("name")).toString();
        const QByteArray n = name.toUtf8();
        const int idx = obj->metaObject()->indexOfProperty(n.constData());
        if (idx >= 0) {
            reply->ok(QJsonObject { { QStringLiteral("value"), propertyToJson(obj, obj->metaObject()->property(idx), m_mapper) } });
            return;
        }
        if (obj->dynamicPropertyNames().contains(n)) {
            reply->ok(QJsonObject { { QStringLiteral("value"), variantToJson(obj->property(n.constData()), m_mapper) } });
            return;
        }
        reply->fail(NotFound, QStringLiteral("%1 has no property '%2'").arg(Element::displayTypeName(obj), name));
    };

    h[QStringLiteral("getProperties")] = [this](QWebSocket *, const QJsonObject &params, const ReplyPtr &reply) {
        QObject *obj = resolve(params, reply);
        if (!obj)
            return;
        QJsonObject props;
        const QMetaObject *mo = obj->metaObject();
        for (int i = 0; i < mo->propertyCount(); ++i) {
            const QMetaProperty prop = mo->property(i);
            if (prop.isReadable())
                props.insert(QString::fromLatin1(prop.name()), propertyToJson(obj, prop, m_mapper));
        }
        const auto dyn = obj->dynamicPropertyNames();
        for (const QByteArray &n : dyn) {
            if (!n.startsWith("_q_"))
                props.insert(QString::fromUtf8(n), variantToJson(obj->property(n.constData()), m_mapper));
        }
        reply->ok(QJsonObject { { QStringLiteral("properties"), props } });
    };

    h[QStringLiteral("setProperty")] = [this](QWebSocket *, const QJsonObject &params, const ReplyPtr &reply) {
        QObject *obj = resolve(params, reply);
        if (!obj)
            return;
        QString error;
        if (writeProperty(obj, params.value(QStringLiteral("name")).toString(), params.value(QStringLiteral("value")), m_mapper, &error))
            reply->ok();
        else
            reply->fail(Failed, error);
    };

    h[QStringLiteral("invokeMethod")] = [this](QWebSocket *, const QJsonObject &params, const ReplyPtr &reply) {
        QObject *obj = resolve(params, reply);
        if (!obj)
            return;
        const QJsonArray args = params.value(QStringLiteral("args")).toArray();
        QString error;
        const QMetaMethod m = findMethod(obj->metaObject(), params.value(QStringLiteral("method")).toString(),
                                         args.size(), QMetaMethod::Method, &error);
        if (!m.isValid()) {
            reply->fail(NotFound, error);
            return;
        }
        QJsonValue result;
        if (invokeMethod(obj, m, args, m_mapper, &result, &error))
            reply->ok(QJsonObject { { QStringLiteral("value"), result } });
        else
            reply->fail(Failed, error);
    };

    auto simple = [this](std::function<QJsonValue(QObject *)> fn) {
        return [this, fn](QWebSocket *, const QJsonObject &params, const ReplyPtr &reply) {
            if (QObject *obj = resolve(params, reply))
                reply->ok(QJsonObject { { QStringLiteral("value"), fn(obj) } });
        };
    };
    h[QStringLiteral("isVisible")] = simple([](QObject *o) { return QJsonValue(Element::isVisible(o)); });
    h[QStringLiteral("isEnabled")] = simple([](QObject *o) { return QJsonValue(Element::isEnabled(o)); });
    h[QStringLiteral("text")] = simple([](QObject *o) { return QJsonValue(Element::text(o)); });
    h[QStringLiteral("geometry")] = simple([](QObject *o) {
        return Element::hasGeometry(o) ? QJsonValue(rectToJson(Element::globalGeometry(o))) : QJsonValue();
    });

    h[QStringLiteral("scrollIntoView")] = [this](QWebSocket *, const QJsonObject &params, const ReplyPtr &reply) {
        if (QObject *obj = resolve(params, reply))
            reply->ok(QJsonObject { { QStringLiteral("scrolled"), Element::scrollIntoView(obj) } });
    };

    h[QStringLiteral("focus")] = [this](QWebSocket *, const QJsonObject &params, const ReplyPtr &reply) {
        QObject *obj = resolve(params, reply);
        if (!obj)
            return;
        QString error;
        if (Element::focus(obj, &error))
            reply->ok();
        else
            reply->fail(NotActionable, error);
    };

    h[QStringLiteral("click")] = [this](QWebSocket *, const QJsonObject &params, const ReplyPtr &reply) {
        if (QObject *obj = resolve(params, reply))
            enqueueClick(obj, params, qBound(1, params.value(QStringLiteral("clickCount")).toInt(1), 3), reply);
    };
    h[QStringLiteral("doubleClick")] = [this](QWebSocket *, const QJsonObject &params, const ReplyPtr &reply) {
        if (QObject *obj = resolve(params, reply))
            enqueueClick(obj, params, 2, reply);
    };

    h[QStringLiteral("hover")] = [this](QWebSocket *, const QJsonObject &params, const ReplyPtr &reply) {
        QObject *target = resolve(params, reply);
        if (!target)
            return;
        const QPointer<QObject> obj(target);
        const QPointF local = positionParam(target, params);
        m_input->enqueue([=]() {
            if (!obj) {
                reply->fail(StaleHandle, QStringLiteral("element was destroyed before hovering"));
                return;
            }
            QString err;
            const auto t = Element::inputTarget(obj, local, &err);
            if (!t.window) {
                reply->fail(NotActionable, err);
                return;
            }
            reply->ok();
            Input::mouseMove(t.window, t.windowPos);
        });
    };

    h[QStringLiteral("type")] = [this](QWebSocket *, const QJsonObject &params, const ReplyPtr &reply) {
        QObject *obj = nullptr;
        if (params.contains(QStringLiteral("handle")) && !(obj = resolve(params, reply)))
            return;
        enqueueTyping(obj, params.value(QStringLiteral("text")).toString(), false, reply);
    };
    h[QStringLiteral("fill")] = [this](QWebSocket *, const QJsonObject &params, const ReplyPtr &reply) {
        if (QObject *obj = resolve(params, reply))
            enqueueTyping(obj, params.value(QStringLiteral("text")).toString(), true, reply);
    };

    h[QStringLiteral("press")] = [this](QWebSocket *, const QJsonObject &params, const ReplyPtr &reply) {
        QObject *target = nullptr;
        if (params.contains(QStringLiteral("handle")) && !(target = resolve(params, reply)))
            return;
        Input::KeySpec key;
        QString error;
        if (!Input::parseKey(params.value(QStringLiteral("key")).toString(), &key, &error)) {
            reply->fail(InvalidParams, error);
            return;
        }
        const QPointer<QObject> obj(target);
        const bool focusFirst = target && params.value(QStringLiteral("focus")).toBool(true);
        auto window = std::make_shared<QPointer<QWindow>>();
        m_input->enqueue([=]() {
            QString err;
            if (target && !obj) {
                reply->fail(StaleHandle, QStringLiteral("element was destroyed before the key press"));
                return;
            }
            if (focusFirst && !Element::focus(obj, &err)) {
                reply->fail(NotActionable, err);
                return;
            }
            *window = obj ? Element::inputTarget(obj, QPointF(), &err).window : QGuiApplication::focusWindow();
            if (!*window) {
                reply->fail(NotActionable, QStringLiteral("no window to send keyboard input to"));
                return;
            }
            Input::keyPress(*window, key.key, key.modifiers, key.text);
        });
        m_input->enqueue([=]() {
            if (reply->isDone())
                return;
            // the press may have closed the window (e.g. Escape on a dialog)
            reply->ok();
            Input::keyRelease(*window, key.key, key.modifiers, key.text);
        });
    };

    h[QStringLiteral("scroll")] = [this](QWebSocket *, const QJsonObject &params, const ReplyPtr &reply) {
        QObject *target = resolve(params, reply);
        if (!target)
            return;
        const QPointer<QObject> obj(target);
        const QPointF local = positionParam(target, params);
        const QPoint delta(-params.value(QStringLiteral("deltaX")).toInt(), -params.value(QStringLiteral("deltaY")).toInt());
        m_input->enqueue([=]() {
            if (!obj) {
                reply->fail(StaleHandle, QStringLiteral("element was destroyed before scrolling"));
                return;
            }
            QString err;
            const auto t = Element::inputTarget(obj, local, &err);
            if (!t.window) {
                reply->fail(NotActionable, err);
                return;
            }
            Input::mouseMove(t.window, t.windowPos);
            reply->ok();
            Input::wheel(t.window, t.windowPos, delta);
        });
    };

    h[QStringLiteral("drag")] = [this](QWebSocket *, const QJsonObject &params, const ReplyPtr &reply) {
        QObject *source = resolve(params, reply);
        if (!source)
            return;
        QObject *targetObj = nullptr;
        if (params.contains(QStringLiteral("target")) && !(targetObj = resolve(params, reply, QStringLiteral("target"))))
            return;
        if (!targetObj && !params.value(QStringLiteral("offset")).isObject()) {
            reply->fail(InvalidParams, QStringLiteral("drag needs either 'target' or 'offset'"));
            return;
        }
        ClickOptions opts;
        QString error;
        if (!parseClickOptions(params, &opts, &error)) {
            reply->fail(InvalidParams, error);
            return;
        }
        const QPointer<QObject> src(source);
        const QPointer<QObject> dst(targetObj);
        const QPointF srcLocal = positionParam(source, params);
        const QPointF dstLocal = targetObj ? positionParam(targetObj, params, QStringLiteral("targetPosition")) : QPointF();
        const auto off = params.value(QStringLiteral("offset")).toObject();
        const QPointF offset(off.value(QStringLiteral("x")).toDouble(), off.value(QStringLiteral("y")).toDouble());
        const int steps = qBound(1, params.value(QStringLiteral("steps")).toInt(10), 200);

        struct DragState
        {
            QPointer<QWindow> window;
            QPointF from;
            QPointF to;
        };
        auto state = std::make_shared<DragState>();

        m_input->enqueue([=]() {
            if (!src || (targetObj && !dst)) {
                reply->fail(StaleHandle, QStringLiteral("drag source or target was destroyed"));
                return;
            }
            QString err;
            const auto s = Element::inputTarget(src, srcLocal, &err);
            if (!s.window) {
                reply->fail(NotActionable, err);
                return;
            }
            state->window = s.window;
            state->from = s.windowPos;
            if (dst) {
                const auto d = Element::inputTarget(dst, dstLocal, &err);
                if (!d.window) {
                    reply->fail(NotActionable, err);
                    return;
                }
                // express the drop point in the source window's coordinates
                state->to = s.window->mapFromGlobal(d.window->mapToGlobal(d.windowPos));
            } else {
                state->to = state->from + offset;
            }
            Input::mouseMove(s.window, state->from, opts.modifiers);
        });
        m_input->enqueue([=]() {
            if (!reply->isDone() && state->window)
                Input::mousePress(state->window, state->from, opts.button, opts.modifiers);
        });
        for (int i = 1; i <= steps; ++i) {
            m_input->enqueue([=]() {
                if (reply->isDone() || !state->window)
                    return;
                const qreal f = qreal(i) / steps;
                Input::mouseMove(state->window, state->from + (state->to - state->from) * f, opts.modifiers);
            });
        }
        m_input->enqueue([=]() {
            if (reply->isDone())
                return;
            reply->ok();
            Input::mouseRelease(state->window, state->to, opts.button, opts.modifiers);
        });
    };

    // resolves once all previously queued input has been delivered
    h[QStringLiteral("sync")] = [this](QWebSocket *, const QJsonObject &, const ReplyPtr &reply) {
        m_input->enqueue([reply]() { reply->ok(); });
    };

    h[QStringLiteral("screenshot")] = [this](QWebSocket *, const QJsonObject &params, const ReplyPtr &reply) {
        QObject *obj = nullptr;
        if (params.contains(QStringLiteral("handle"))) {
            obj = resolve(params, reply);
            if (!obj)
                return;
        } else {
            // prefer the focus window, else the first visible top-level window
            const auto windows = Element::topLevelWindows();
            QWindow *focus = QGuiApplication::focusWindow();
            for (QObject *w : windows) {
                QString ignored;
                if (!obj || (focus && Element::inputTarget(w, QPointF(), &ignored).window == focus))
                    obj = w;
            }
            if (!obj) {
                reply->fail(NotFound, QStringLiteral("no visible window to take a screenshot of"));
                return;
            }
        }
        QString error;
        const QImage img = Element::grab(obj, params.value(QStringLiteral("window")).toBool(), &error);
        if (img.isNull()) {
            reply->fail(Failed, error.isEmpty() ? QStringLiteral("failed to grab image") : error);
            return;
        }
        QByteArray png;
        QBuffer buffer(&png);
        buffer.open(QIODevice::WriteOnly);
        img.save(&buffer, "PNG");
        reply->ok(QJsonObject { { QStringLiteral("png"), QString::fromLatin1(png.toBase64()) },
                                { QStringLiteral("width"), img.width() },
                                { QStringLiteral("height"), img.height() } });
    };

    h[QStringLiteral("waitForSignal")] = [this](QWebSocket *, const QJsonObject &params, const ReplyPtr &reply) {
        QObject *obj = resolve(params, reply);
        if (!obj)
            return;
        QString error;
        const QMetaMethod signal = findMethod(obj->metaObject(), params.value(QStringLiteral("signal")).toString(), -1,
                                              QMetaMethod::Signal, &error);
        if (!signal.isValid()) {
            reply->fail(NotFound, error);
            return;
        }
        const int timeout = params.value(QStringLiteral("timeout")).toInt(30000);
        auto relay = std::make_shared<QPointer<SignalRelay>>();
        auto timer = std::make_shared<QPointer<QTimer>>();
        auto cleanup = [relay, timer]() {
            if (*relay)
                (*relay)->deleteLater();
            if (*timer)
                (*timer)->deleteLater();
        };
        ProbeGuard guard;
        *relay = new SignalRelay(
            obj, signal,
            [this, reply, cleanup](const QVariantList &args) {
                QJsonArray arr;
                for (const auto &a : args)
                    arr.push_back(variantToJson(a, m_mapper));
                reply->ok(QJsonObject { { QStringLiteral("args"), arr } });
                cleanup();
            },
            this);
        if (!(*relay)->isConnected()) {
            reply->fail(Failed, QStringLiteral("could not connect to %1").arg(QString::fromLatin1(signal.methodSignature())));
            cleanup();
            return;
        }
        *timer = new QTimer(this);
        (*timer)->setSingleShot(true);
        connect(*timer, &QTimer::timeout, this, [reply, cleanup, signal, timeout]() {
            reply->fail(Timeout, QStringLiteral("timed out after %1 ms waiting for signal %2").arg(timeout).arg(QString::fromLatin1(signal.methodSignature())));
            cleanup();
        });
        connect(obj, &QObject::destroyed, *timer, [reply, cleanup]() {
            reply->fail(StaleHandle, QStringLiteral("element was destroyed while waiting for the signal"));
            cleanup();
        });
        (*timer)->start(timeout);
    };

    h[QStringLiteral("spy")] = [this](QWebSocket *socket, const QJsonObject &params, const ReplyPtr &reply) {
        QObject *obj = resolve(params, reply);
        if (!obj)
            return;
        QString error;
        const QMetaMethod signal = findMethod(obj->metaObject(), params.value(QStringLiteral("signal")).toString(), -1,
                                              QMetaMethod::Signal, &error);
        if (!signal.isValid()) {
            reply->fail(NotFound, error);
            return;
        }
        const qint64 spyId = m_nextSpyId++;
        auto emissions = std::make_shared<QJsonArray>();
        ProbeGuard guard;
        auto relay = new SignalRelay(
            obj, signal,
            [this, emissions](const QVariantList &args) {
                QJsonArray arr;
                for (const auto &a : args)
                    arr.push_back(variantToJson(a, m_mapper));
                emissions->push_back(arr);
            },
            this);
        m_sessions[socket].spies.insert(spyId, Spy { relay, emissions });
        reply->ok(QJsonObject { { QStringLiteral("spyId"), double(spyId) } });
    };

    h[QStringLiteral("spyEvents")] = [this](QWebSocket *socket, const QJsonObject &params, const ReplyPtr &reply) {
        const qint64 spyId = static_cast<qint64>(params.value(QStringLiteral("spyId")).toDouble());
        const Spy spy = m_sessions[socket].spies.value(spyId);
        if (!spy.relay) {
            reply->fail(NotFound, QStringLiteral("unknown spy %1").arg(spyId));
            return;
        }
        const auto &emissions = spy.emissions;
        reply->ok(QJsonObject { { QStringLiteral("count"), emissions->size() }, { QStringLiteral("emissions"), *emissions } });
        if (params.value(QStringLiteral("clear")).toBool())
            *emissions = QJsonArray();
    };

    h[QStringLiteral("unspy")] = [this](QWebSocket *socket, const QJsonObject &params, const ReplyPtr &reply) {
        const qint64 spyId = static_cast<qint64>(params.value(QStringLiteral("spyId")).toDouble());
        delete m_sessions[socket].spies.take(spyId).relay;
        reply->ok();
    };

    // video recording: frames are streamed as binary messages, see Recorder
    h[QStringLiteral("startRecording")] = [this](QWebSocket *socket, const QJsonObject &params, const ReplyPtr &reply) {
        Recorder::Options opts;
        opts.fps = params.value(QStringLiteral("fps")).toInt(opts.fps);
        opts.scale = params.value(QStringLiteral("scale")).toDouble(opts.scale);
        opts.quality = params.value(QStringLiteral("quality")).toInt(opts.quality);
        opts.chrome = params.value(QStringLiteral("chrome")).toBool(opts.chrome);
        opts.cursor = params.value(QStringLiteral("cursor")).toBool(opts.cursor);
        const auto size = params.value(QStringLiteral("size")).toObject();
        if (!size.isEmpty())
            opts.size = QSize(size.value(QStringLiteral("width")).toInt(), size.value(QStringLiteral("height")).toInt());

        const QPointer<QWebSocket> target(socket);
        auto sink = [target](const QByteArray &frame) {
            // don't let a slow client make the application buffer unbounded amounts of video
            if (!target || target->bytesToWrite() > 64 * 1024 * 1024)
                return false;
            target->sendBinaryMessage(frame);
            return true;
        };
        ProbeGuard guard;
        auto recorder = new Recorder(m_nextRecordingId++, opts, sink, this);
        m_sessions[socket].recorders.insert(recorder->id(), recorder);
        reply->ok(QJsonObject { { QStringLiteral("recordingId"), double(recorder->id()) },
                                { QStringLiteral("width"), recorder->frameSize().width() },
                                { QStringLiteral("height"), recorder->frameSize().height() },
                                { QStringLiteral("fps"), opts.fps },
                                { QStringLiteral("format"), QString::fromLatin1(recorder->format()) } });
        // the first frame goes out after the reply, so the client knows the format first
        recorder->start();
    };

    h[QStringLiteral("stopRecording")] = [this](QWebSocket *socket, const QJsonObject &params, const ReplyPtr &reply) {
        const auto id = quint32(params.value(QStringLiteral("recordingId")).toDouble());
        Recorder *recorder = m_sessions[socket].recorders.take(id);
        if (!recorder) {
            reply->fail(NotFound, QStringLiteral("unknown recording %1").arg(id));
            return;
        }
        recorder->stop(); // sends the final frame before our reply
        reply->ok(QJsonObject { { QStringLiteral("frames"), recorder->framesSent() },
                                { QStringLiteral("duration"), double(recorder->elapsed()) } });
        recorder->deleteLater();
    };

    h[QStringLiteral("subscribe")] = [this](QWebSocket *socket, const QJsonObject &params, const ReplyPtr &reply) {
        const auto events = params.value(QStringLiteral("events")).toArray();
        const bool on = params.value(QStringLiteral("enabled")).toBool(true);
        auto &session = m_sessions[socket];
        for (const auto &e : events) {
            if (e.toString() == QLatin1String("objectCreated"))
                session.objectCreatedEvents = on;
            else if (e.toString() == QLatin1String("objectDestroyed"))
                session.objectDestroyedEvents = on;
            else {
                reply->fail(InvalidParams, QStringLiteral("unknown event '%1'").arg(e.toString()));
                return;
            }
        }
        reply->ok();
    };
}
