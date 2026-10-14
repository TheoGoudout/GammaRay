/*
  automationcodegen.h

  This file is part of GammaRay, the Qt application inspection and manipulation tool.

  SPDX-FileCopyrightText: 2026 Klarälvdalens Datakonsult AB, a KDAB Group company <info@kdab.com>

  SPDX-License-Identifier: GPL-2.0-or-later

  Contact KDAB at <info@kdab.com> for commercial licensing options.
*/

#ifndef GAMMARAY_AUTOMATIONCODEGEN_H
#define GAMMARAY_AUTOMATIONCODEGEN_H

#include <QJsonObject>
#include <QObject>
#include <QPointF>
#include <QPointer>

#include <functional>

namespace GammaRay {
namespace Automation {

/*!
 * Records what the user does in the application as high-level actions (click, fill,
 * press, check, selectOption, dragTo...), for generating test code ("codegen").
 *
 * Works through an application-wide event filter, so it sees real user input as well
 * as input synthesized by the automation API. Targets are reported as objects; turning
 * them into locators is up to the LocatorFactory.
 */
class ActionRecorder : public QObject
{
    Q_OBJECT
public:
    using LocatorFactory = std::function<QJsonObject(QObject *)>; // {code, selector}
    using ActionSink = std::function<void(const QJsonObject &)>;
    using ObjectFilter = std::function<bool(QObject *)>;

    ActionRecorder(LocatorFactory locator, ActionSink sink, ObjectFilter accept, QObject *parent = nullptr);
    ~ActionRecorder() override;

    /*! Emits pending typing as a fill action. */
    void flush();

protected:
    bool eventFilter(QObject *receiver, QEvent *event) override;

private:
    QObject *pointerTarget(QObject *receiver, QPointF windowPos) const;
    QObject *meaningfulAncestor(QObject *obj) const;
    void emitAction(const QString &action, QObject *target, const QJsonObject &extra = QJsonObject());
    void handleRelease(QObject *target, QPointF globalPos, QObject *releaseTarget);
    static bool isCheckedRow(QObject *obj);

    LocatorFactory m_locator;
    ActionSink m_sink;
    ObjectFilter m_accept;

    const QEvent *m_lastEvent = nullptr;
    int m_lastEventType = 0;
    QPointer<QObject> m_pressTarget;
    QPointF m_pressGlobalPos;
    QPointF m_pressLocalPos;
    Qt::KeyboardModifiers m_pressModifiers;
    bool m_pressChecked = false;
    bool m_comboPopup = false;
    QPointer<QObject> m_typingTarget;
};

}
}

#endif
