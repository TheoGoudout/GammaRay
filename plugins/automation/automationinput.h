/*
  automationinput.h

  This file is part of GammaRay, the Qt application inspection and manipulation tool.

  SPDX-FileCopyrightText: 2026 Klarälvdalens Datakonsult AB, a KDAB Group company <info@kdab.com>

  SPDX-License-Identifier: GPL-2.0-or-later

  Contact KDAB at <info@kdab.com> for commercial licensing options.
*/

#ifndef GAMMARAY_AUTOMATIONINPUT_H
#define GAMMARAY_AUTOMATIONINPUT_H

#include <QObject>
#include <QPointF>
#include <QString>
#include <QTimer>

#include <deque>
#include <functional>

QT_BEGIN_NAMESPACE
class QWindow;
QT_END_NAMESPACE

namespace GammaRay {
namespace Automation {

/*!
 * Synthesizes input through QtGui's window system interface, i.e. the same path
 * real platform input and QTest take (hit testing, modality, focus, enter/leave,
 * double-click detection all behave as for a real user).
 *
 * Positions are in window coordinates. Unlike QTest we never spin the event loop.
 */
namespace Input {
void mouseMove(QWindow *window, QPointF pos, Qt::KeyboardModifiers mods = Qt::NoModifier);
void mousePress(QWindow *window, QPointF pos, Qt::MouseButton button, Qt::KeyboardModifiers mods = Qt::NoModifier);
/*! @p endOfClick: advance the clock so the next press is not seen as a double click. */
void mouseRelease(QWindow *window, QPointF pos, Qt::MouseButton button, Qt::KeyboardModifiers mods = Qt::NoModifier,
                  bool endOfClick = true);
void wheel(QWindow *window, QPointF pos, QPoint angleDelta, Qt::KeyboardModifiers mods = Qt::NoModifier);
void keyPress(QWindow *window, int key, Qt::KeyboardModifiers mods, const QString &text);
void keyRelease(QWindow *window, int key, Qt::KeyboardModifiers mods, const QString &text);

struct KeySpec
{
    int key = 0;
    Qt::KeyboardModifiers modifiers;
    QString text;
};
/*! Parses Playwright-style key names: "Enter", "Control+A", "Shift+ArrowDown", "a", "F5". */
bool parseKey(const QString &spec, KeySpec *out, QString *error);
/*! Key event data for typing a single character. */
KeySpec keyForCharacter(QChar c);

Qt::MouseButton parseButton(const QString &name, bool *ok);
Qt::KeyboardModifiers parseModifiers(const QStringList &names, bool *ok);
}

/*!
 * Executes input actions as a sequence of small steps, one per event loop iteration.
 *
 * Each step is run from a zero-timer that is re-armed *before* the step executes, so
 * when a step enters a nested event loop (QDialog::exec(), QDrag::exec(), a QMenu...)
 * the remaining steps keep running inside it, exactly like further user input would.
 */
class InputQueue : public QObject
{
    Q_OBJECT
public:
    explicit InputQueue(QObject *parent = nullptr);
    void enqueue(std::function<void()> step);
    bool isIdle() const
    {
        return m_steps.empty();
    }

private:
    void runNext();

    QTimer m_timer;
    std::deque<std::function<void()>> m_steps;
};

}
}

#endif
