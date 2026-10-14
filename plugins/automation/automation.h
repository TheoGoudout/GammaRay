/*
  automation.h

  This file is part of GammaRay, the Qt application inspection and manipulation tool.

  SPDX-FileCopyrightText: 2026 Klarälvdalens Datakonsult AB, a KDAB Group company <info@kdab.com>

  SPDX-License-Identifier: GPL-2.0-or-later

  Contact KDAB at <info@kdab.com> for commercial licensing options.
*/

#ifndef GAMMARAY_AUTOMATION_H
#define GAMMARAY_AUTOMATION_H

#include "automationhandles.h"
#include "automationhighlight.h"
#include "automationjson.h"

#include <core/toolfactory.h>

#include <QHash>
#include <QJsonArray>
#include <QJsonObject>
#include <QPointer>
#include <QSet>
#include <QTimer>

#include <functional>
#include <memory>

QT_BEGIN_NAMESPACE
class QWebSocket;
class QWebSocketServer;
QT_END_NAMESPACE

namespace GammaRay {
namespace Automation {
class ActionRecorder;
class InputQueue;
class Recorder;
class SelectorEngine;
class SignalRelay;
class Reply;
}

/*!
 * Probe-side automation server: a JSON-RPC 2.0 API over WebSocket for driving the
 * application from end-to-end tests (see automation/client for the TypeScript library).
 *
 * Opt-in: only listens if GAMMARAY_AUTOMATION_PORT (or the probe setting AutomationPort)
 * is set; 0 picks a free port. Everything runs on the GUI thread.
 */
class AutomationServer : public QObject
{
    Q_OBJECT
public:
    explicit AutomationServer(Probe *probe, QObject *parent = nullptr);
    ~AutomationServer() override;

private:
    using ReplyPtr = std::shared_ptr<Automation::Reply>;
    using Handler = std::function<void(QWebSocket *, const QJsonObject &, const ReplyPtr &)>;

    struct Spy
    {
        Automation::SignalRelay *relay = nullptr;
        std::shared_ptr<QJsonArray> emissions;
    };
    struct Session
    {
        bool objectCreatedEvents = false;
        bool objectDestroyedEvents = false;
        QHash<qint64, Spy> spies;
        QHash<quint32, Automation::Recorder *> recorders;
        Automation::ActionRecorder *codegen = nullptr;
    };

    void listen();
    void newConnection();
    void textMessageReceived(QWebSocket *socket, const QString &message);
    void socketDisconnected(QWebSocket *socket);
    void registerHandlers();

    void objectCreated(QObject *obj);
    void objectDestroyed(QObject *obj);
    void flushObjectEvents();
    void broadcast(const QString &method, const QJsonObject &params, bool Session::*filter);

    QObject *resolve(const QJsonObject &params, const ReplyPtr &reply, const QString &key = QStringLiteral("handle"));
    QJsonValue objectToJson(QObject *obj);
    QJsonObject describe(QObject *obj);
    QVector<QObject *> roots() const;
    bool accept(QObject *obj) const;
    QVector<QObject *> allObjects() const;
    QPointF positionParam(QObject *obj, const QJsonObject &params, const QString &key = QStringLiteral("position")) const;

    QJsonObject accessibilityNode(QObject *obj, int depth);
    QJsonObject snapshotNode(QObject *obj, int depth, int *budget, const QSet<QObject *> &windows);
    QJsonObject codegenLocator(QObject *obj);
    void registerExtendedHandlers();

    // input actions
    void enqueueClick(QObject *obj, const QJsonObject &params, int clickCount, const ReplyPtr &reply);
    void enqueueTyping(QObject *obj, const QString &text, bool clearFirst, const ReplyPtr &reply, bool commitWithEnter = false);

    Probe *m_probe;
    QWebSocketServer *m_server = nullptr;
    QString m_portFile;
    Automation::HandleRegistry m_handles;
    Automation::ObjectMapper m_mapper;
    std::unique_ptr<Automation::SelectorEngine> m_engine;
    Automation::InputQueue *m_input;
    QHash<QString, Handler> m_handlers;
    QHash<QWebSocket *, Session> m_sessions;
    QObject *m_jsEngine = nullptr; // private QJSEngine for evaluate() on non-QML objects
    Automation::Highlighter *m_highlighter = nullptr;
    qint64 m_nextSpyId = 1;
    quint32 m_nextRecordingId = 1;

    QTimer m_eventFlushTimer;
    QJsonArray m_pendingCreated;
    QJsonArray m_pendingDestroyed;
};

class AutomationFactory : public QObject, public StandardToolFactory<QObject, AutomationServer>
{
    Q_OBJECT
    Q_INTERFACES(GammaRay::ToolFactory)
    Q_PLUGIN_METADATA(IID "com.kdab.GammaRay.ToolFactory" FILE "gammaray_automation.json")
public:
    explicit AutomationFactory(QObject *parent = nullptr)
        : QObject(parent)
    {
    }
};
}

#endif
