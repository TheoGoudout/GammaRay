/*
  automationjson.cpp

  This file is part of GammaRay, the Qt application inspection and manipulation tool.

  SPDX-FileCopyrightText: 2026 Klarälvdalens Datakonsult AB, a KDAB Group company <info@kdab.com>

  SPDX-License-Identifier: GPL-2.0-or-later

  Contact KDAB at <info@kdab.com> for commercial licensing options.
*/

#include "automationjson.h"

#include <QColor>
#include <QDateTime>
#include <QFont>
#include <QJsonObject>
#include <QLineF>
#include <QPointF>
#include <QRectF>
#include <QSizeF>
#include <QUrl>

#ifdef QT_QML_LIB
#include <QJSValue>
#endif

#include <memory>
#include <vector>

using namespace GammaRay;
using namespace GammaRay::Automation;

static QJsonObject pointToJson(QPointF p)
{
    return QJsonObject { { QStringLiteral("x"), p.x() }, { QStringLiteral("y"), p.y() } };
}

static QJsonObject sizeToJson(QSizeF s)
{
    return QJsonObject { { QStringLiteral("width"), s.width() }, { QStringLiteral("height"), s.height() } };
}

static QJsonObject rectToJson(QRectF r)
{
    return QJsonObject { { QStringLiteral("x"), r.x() },
                         { QStringLiteral("y"), r.y() },
                         { QStringLiteral("width"), r.width() },
                         { QStringLiteral("height"), r.height() } };
}

static QString jsonTypeName(const QJsonValue &v)
{
    switch (v.type()) {
    case QJsonValue::Null:
        return QStringLiteral("null");
    case QJsonValue::Bool:
        return QStringLiteral("boolean");
    case QJsonValue::Double:
        return QStringLiteral("number");
    case QJsonValue::String:
        return QStringLiteral("string");
    case QJsonValue::Array:
        return QStringLiteral("array");
    case QJsonValue::Object:
        return QStringLiteral("object");
    default:
        return QStringLiteral("undefined");
    }
}

static QJsonValue enumToJson(const QMetaEnum &me, int value)
{
    if (me.isFlag()) {
        const QByteArray keys = me.valueToKeys(value);
        return keys.isEmpty() ? QJsonValue(value) : QJsonValue(QString::fromLatin1(keys));
    }
    const char *key = me.valueToKey(value);
    return key ? QJsonValue(QString::fromLatin1(key)) : QJsonValue(value);
}

QJsonValue Automation::variantToJson(const QVariant &value, const ObjectMapper &mapper)
{
    if (!value.isValid())
        return QJsonValue::Null;

    const QMetaType mt = value.metaType();
    if (mt.flags() & QMetaType::PointerToQObject) {
        auto obj = *reinterpret_cast<QObject *const *>(value.constData());
        return mapper.toJson(obj);
    }

    if (mt.flags() & QMetaType::IsEnumeration) {
        if (const QMetaObject *mo = mt.metaObject()) {
            QByteArray name = mt.name();
            const int idx = name.lastIndexOf("::");
            if (idx >= 0)
                name = name.mid(idx + 2);
            const int enumIdx = mo->indexOfEnumerator(name.constData());
            if (enumIdx >= 0)
                return enumToJson(mo->enumerator(enumIdx), value.toInt());
        }
        return value.toInt();
    }

    switch (mt.id()) {
    case QMetaType::Nullptr:
    case QMetaType::Void:
        return QJsonValue::Null;
    case QMetaType::Bool:
        return value.toBool();
    case QMetaType::Int:
    case QMetaType::UInt:
    case QMetaType::Short:
    case QMetaType::UShort:
    case QMetaType::Long:
    case QMetaType::LongLong:
    case QMetaType::ULong:
    case QMetaType::ULongLong:
    case QMetaType::Char:
    case QMetaType::SChar:
    case QMetaType::UChar:
        return value.toLongLong();
    case QMetaType::Double:
    case QMetaType::Float:
        return value.toDouble();
    case QMetaType::QString:
        return value.toString();
    case QMetaType::QByteArray:
        return QString::fromUtf8(value.toByteArray());
    case QMetaType::QStringList:
        return QJsonArray::fromStringList(value.toStringList());
    case QMetaType::QVariantList: {
        QJsonArray arr;
        const auto list = value.toList();
        for (const auto &v : list)
            arr.push_back(variantToJson(v, mapper));
        return arr;
    }
    case QMetaType::QVariantMap: {
        QJsonObject obj;
        const auto map = value.toMap();
        for (auto it = map.begin(); it != map.end(); ++it)
            obj.insert(it.key(), variantToJson(it.value(), mapper));
        return obj;
    }
    case QMetaType::QVariantHash: {
        QJsonObject obj;
        const auto map = value.toHash();
        for (auto it = map.begin(); it != map.end(); ++it)
            obj.insert(it.key(), variantToJson(it.value(), mapper));
        return obj;
    }
    case QMetaType::QPoint:
    case QMetaType::QPointF:
        return pointToJson(value.toPointF());
    case QMetaType::QSize:
    case QMetaType::QSizeF:
        return sizeToJson(value.toSizeF());
    case QMetaType::QRect:
    case QMetaType::QRectF:
        return rectToJson(value.toRectF());
    case QMetaType::QLine:
    case QMetaType::QLineF: {
        const QLineF l = value.toLineF();
        return QJsonObject { { QStringLiteral("p1"), pointToJson(l.p1()) },
                             { QStringLiteral("p2"), pointToJson(l.p2()) } };
    }
    case QMetaType::QColor: {
        const auto c = value.value<QColor>();
        return c.name(c.alpha() == 255 ? QColor::HexRgb : QColor::HexArgb);
    }
    case QMetaType::QUrl:
        return value.toUrl().toString();
    case QMetaType::QDateTime:
        return value.toDateTime().toString(Qt::ISODateWithMs);
    case QMetaType::QDate:
        return value.toDate().toString(Qt::ISODate);
    case QMetaType::QTime:
        return value.toTime().toString(Qt::ISODateWithMs);
    case QMetaType::QFont:
        return value.value<QFont>().toString();
    case QMetaType::QJsonValue:
        return value.toJsonValue();
    case QMetaType::QJsonObject:
        return value.toJsonObject();
    case QMetaType::QJsonArray:
        return value.toJsonArray();
    default:
        break;
    }

#ifdef QT_QML_LIB
    if (mt == QMetaType::fromType<QJSValue>()) {
        const auto js = value.value<QJSValue>();
        if (js.isQObject())
            return mapper.toJson(js.toQObject());
        return variantToJson(js.toVariant(), mapper);
    }
#endif

    // Sequences registered with the meta type system (QList<int>, QList<QObject*>, ...)
    if (value.canConvert<QVariantList>() && !value.canConvert<QString>()) {
        QJsonArray arr;
        const auto list = value.value<QVariantList>();
        for (const auto &v : list)
            arr.push_back(variantToJson(v, mapper));
        return arr;
    }
    if (value.canConvert<QString>())
        return value.toString();

    return QJsonObject { { QStringLiteral("type"), QString::fromLatin1(mt.name()) } };
}

QJsonValue Automation::propertyToJson(const QObject *obj, const QMetaProperty &prop, const ObjectMapper &mapper)
{
    const QVariant value = prop.read(obj);
    if (prop.isEnumType() && value.isValid())
        return enumToJson(prop.enumerator(), value.toInt());
    return variantToJson(value, mapper);
}

QVariant Automation::jsonToVariant(const QJsonValue &value, QMetaType type, const ObjectMapper &mapper,
                                   QString *error)
{
    // Element handles: {"handle": n}
    if (value.isObject() && value.toObject().contains(QStringLiteral("handle"))) {
        QObject *obj = mapper.fromJson(value);
        if (!obj) {
            *error = QStringLiteral("stale or unknown element handle");
            return {};
        }
        if (!type.isValid() || type == QMetaType::fromType<QVariant>() || type == QMetaType::fromType<QObject *>())
            return QVariant::fromValue(obj);
        if (type.flags() & QMetaType::PointerToQObject) {
            const QMetaObject *mo = type.metaObject();
            if (mo && !obj->metaObject()->inherits(mo)) {
                *error = QStringLiteral("object of type %1 does not inherit %2")
                             .arg(QString::fromLatin1(obj->metaObject()->className()),
                                  QString::fromLatin1(mo->className()));
                return {};
            }
            // a QVariant holding a QObject* can be reinterpreted for any QObject subclass
            QVariant v(type);
            *reinterpret_cast<QObject **>(v.data()) = obj;
            return v;
        }
    }

    QVariant v = value.toVariant();
    if (!type.isValid() || type == QMetaType::fromType<QVariant>())
        return v;
    if (type == QMetaType::fromType<QJsonValue>())
        return QVariant::fromValue(value);
    if (v.metaType() == type)
        return v;

    // enums / flags given by key name
    if ((type.flags() & QMetaType::IsEnumeration) && value.isString()) {
        if (const QMetaObject *mo = type.metaObject()) {
            QByteArray name = type.name();
            const int idx = name.lastIndexOf("::");
            if (idx >= 0)
                name = name.mid(idx + 2);
            const int enumIdx = mo->indexOfEnumerator(name.constData());
            if (enumIdx >= 0) {
                bool ok = false;
                const auto me = mo->enumerator(enumIdx);
                const int iv = me.isFlag() ? me.keysToValue(value.toString().toLatin1().constData(), &ok)
                                           : me.keyToValue(value.toString().toLatin1().constData(), &ok);
                if (ok) {
                    QVariant ev(iv);
                    ev.convert(type);
                    return ev;
                }
            }
        }
    }

    // structured values
    if (value.isObject()) {
        const auto o = value.toObject();
        auto num = [&o](const char *k) { return o.value(QLatin1String(k)).toDouble(); };
        switch (type.id()) {
        case QMetaType::QPoint:
            return QPoint(qRound(num("x")), qRound(num("y")));
        case QMetaType::QPointF:
            return QPointF(num("x"), num("y"));
        case QMetaType::QSize:
            return QSize(qRound(num("width")), qRound(num("height")));
        case QMetaType::QSizeF:
            return QSizeF(num("width"), num("height"));
        case QMetaType::QRect:
            return QRect(qRound(num("x")), qRound(num("y")), qRound(num("width")), qRound(num("height")));
        case QMetaType::QRectF:
            return QRectF(num("x"), num("y"), num("width"), num("height"));
        default:
            break;
        }
    }
    if (type.id() == QMetaType::QColor && value.isString())
        return QColor::fromString(value.toString());

    if (v.convert(type))
        return v;
    *error = QStringLiteral("cannot convert %1 to %2")
                 .arg(jsonTypeName(value), QString::fromLatin1(type.name()));
    return {};
}

bool Automation::writeProperty(QObject *obj, const QString &name, const QJsonValue &value,
                               const ObjectMapper &mapper, QString *error)
{
    const QByteArray n = name.toUtf8();
    const QMetaObject *mo = obj->metaObject();
    const int idx = mo->indexOfProperty(n.constData());
    if (idx < 0) {
        // dynamic property
        QString convError;
        const QVariant v = jsonToVariant(value, QMetaType(), mapper, &convError);
        if (!convError.isEmpty()) {
            *error = convError;
            return false;
        }
        obj->setProperty(n.constData(), v);
        return true;
    }
    const QMetaProperty prop = mo->property(idx);
    if (!prop.isWritable()) {
        *error = QStringLiteral("property '%1' is read-only").arg(name);
        return false;
    }
    QVariant v;
    if (prop.isEnumType() && value.isString()) {
        bool ok = false;
        const QByteArray key = value.toString().toLatin1();
        const int iv = prop.isFlagType() ? prop.enumerator().keysToValue(key.constData(), &ok)
                                         : prop.enumerator().keyToValue(key.constData(), &ok);
        if (!ok) {
            *error = QStringLiteral("'%1' is not a valid value for enum property '%2'").arg(value.toString(), name);
            return false;
        }
        v = iv;
    } else {
        QString convError;
        v = jsonToVariant(value, prop.metaType(), mapper, &convError);
        if (!convError.isEmpty()) {
            *error = convError;
            return false;
        }
    }
    if (!prop.write(obj, v)) {
        *error = QStringLiteral("failed to write property '%1'").arg(name);
        return false;
    }
    return true;
}

QMetaMethod Automation::findMethod(const QMetaObject *mo, const QString &nameOrSignature, int argc,
                                   QMetaMethod::MethodType type, QString *error)
{
    const QByteArray wanted = nameOrSignature.toUtf8();
    const bool isSignature = wanted.contains('(');
    QMetaMethod best;
    QStringList candidates;
    // iterate from most derived to base so overrides in derived classes win
    for (int i = mo->methodCount() - 1; i >= 0; --i) {
        const QMetaMethod m = mo->method(i);
        if (type == QMetaMethod::Signal && m.methodType() != QMetaMethod::Signal)
            continue;
        if (isSignature) {
            if (QMetaObject::normalizedSignature(wanted.constData()) == m.methodSignature())
                return m;
            continue;
        }
        if (m.name() != wanted)
            continue;
        candidates.push_back(QString::fromLatin1(m.methodSignature()));
        if (argc < 0 || m.parameterCount() == argc) {
            if (!best.isValid())
                best = m;
        }
    }
    if (!best.isValid()) {
        if (candidates.isEmpty())
            *error = QStringLiteral("%1 has no %2 '%3'")
                         .arg(QString::fromLatin1(mo->className()),
                              type == QMetaMethod::Signal ? QStringLiteral("signal") : QStringLiteral("method"),
                              nameOrSignature);
        else
            *error = QStringLiteral("no overload of '%1' takes %2 argument(s); candidates: %3")
                         .arg(nameOrSignature)
                         .arg(argc)
                         .arg(candidates.join(QStringLiteral(", ")));
    }
    return best;
}

bool Automation::invokeMethod(QObject *obj, const QMetaMethod &method, const QJsonArray &args,
                              const ObjectMapper &mapper, QJsonValue *result, QString *error)
{
    const int argc = method.parameterCount();
    if (args.size() != argc) {
        *error = QStringLiteral("%1 expects %2 argument(s), got %3")
                     .arg(QString::fromLatin1(method.methodSignature()))
                     .arg(argc)
                     .arg(args.size());
        return false;
    }

    // storage must stay alive during the call; QVariant data() pointers are stable
    std::vector<QVariant> storage;
    storage.reserve(argc + 1);
    std::vector<void *> argv(argc + 1, nullptr);

    // a QVariant-typed slot argument/return value is passed as a pointer to the QVariant itself
    const QMetaType retType = method.returnMetaType();
    const bool retIsVariant = retType == QMetaType::fromType<QVariant>();
    if (retIsVariant) {
        storage.emplace_back();
        argv[0] = &storage.back();
    } else if (retType.isValid() && retType.id() != QMetaType::Void) {
        storage.emplace_back(retType);
        argv[0] = storage.back().data();
    } else {
        storage.emplace_back();
    }

    for (int i = 0; i < argc; ++i) {
        const QMetaType pt = method.parameterMetaType(i);
        QString convError;
        QVariant v = jsonToVariant(args.at(i), pt, mapper, &convError);
        if (!convError.isEmpty()) {
            *error = QStringLiteral("argument %1: %2").arg(i).arg(convError);
            return false;
        }
        if (pt == QMetaType::fromType<QVariant>()) {
            storage.push_back(v);
            argv[i + 1] = &storage.back();
        } else {
            if (!pt.isValid()) {
                *error = QStringLiteral("argument %1 has an unregistered type").arg(i);
                return false;
            }
            storage.push_back(v);
            argv[i + 1] = storage.back().data();
        }
    }

    // absolute method index; this also works for QML-defined functions (dynamic meta objects)
    QMetaObject::metacall(obj, QMetaObject::InvokeMetaMethod, method.methodIndex(), argv.data());

    if (argv[0]) {
        *result = variantToJson(storage.front(), mapper);
    } else {
        *result = QJsonValue::Null;
    }
    return true;
}
