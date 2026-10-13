/*
  automationjson.h

  This file is part of GammaRay, the Qt application inspection and manipulation tool.

  SPDX-FileCopyrightText: 2026 Klarälvdalens Datakonsult AB, a KDAB Group company <info@kdab.com>

  SPDX-License-Identifier: GPL-2.0-or-later

  Contact KDAB at <info@kdab.com> for commercial licensing options.
*/

#ifndef GAMMARAY_AUTOMATIONJSON_H
#define GAMMARAY_AUTOMATIONJSON_H

#include <QJsonArray>
#include <QJsonValue>
#include <QMetaMethod>
#include <QMetaProperty>
#include <QVariant>

#include <functional>

namespace GammaRay {
namespace Automation {

/*! Maps QObject pointers to JSON (normally {"handle": n, ...}) and back. */
struct ObjectMapper
{
    std::function<QJsonValue(QObject *)> toJson;
    std::function<QObject *(const QJsonValue &)> fromJson;
};

/*! Converts an arbitrary QVariant into a JSON representation. */
QJsonValue variantToJson(const QVariant &value, const ObjectMapper &mapper);

/*! Reads property @p prop of @p obj, rendering enums/flags as key names. */
QJsonValue propertyToJson(const QObject *obj, const QMetaProperty &prop, const ObjectMapper &mapper);

/*! Converts @p value into a QVariant of @p type (or a generic one if @p type is invalid).
 *  Returns an invalid QVariant and sets @p error if the conversion is impossible. */
QVariant jsonToVariant(const QJsonValue &value, QMetaType type, const ObjectMapper &mapper,
                       QString *error);

/*! Writes @p value into property @p name of @p obj. */
bool writeProperty(QObject *obj, const QString &name, const QJsonValue &value,
                   const ObjectMapper &mapper, QString *error);

/*! Finds a method (slot, invokable, signal or QML function) by name or full signature. */
QMetaMethod findMethod(const QMetaObject *mo, const QString &nameOrSignature, int argc,
                       QMetaMethod::MethodType type, QString *error);

/*! Invokes @p method on @p obj with JSON arguments; returns the return value as JSON. */
bool invokeMethod(QObject *obj, const QMetaMethod &method, const QJsonArray &args,
                  const ObjectMapper &mapper, QJsonValue *result, QString *error);

}
}

#endif
