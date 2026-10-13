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
/*! @p endOfClick: advance the clock so the next press is not seen as a double click.
 *  A null @p window only resets the button state. */
void mouseRelease(QWindow *window, QPointF pos, Qt::MouseButton button, Qt::KeyboardModifiers mods = Qt::NoModifier,
                  bool endOfClick = true);
void wheel(QWindow *window, QPointF pos, QPoint angleDelta, Qt::KeyboardModifiers mods = Qt::NoModifier);
void keyPress(QWindow *window, int key, Qt::KeyboardModifiers mods, const QString &text);
/*! No-op for a null @p window. */
void keyRelease(QWindow *window, int key, Qt::KeyboardModifiers mods, const QString &text);

/*! Touch tap (press + release of one finger) through a synthetic touch screen device. */
void touchPress(QWindow *window, QPointF pos);
void touchRelease(QWindow *window, QPointF pos);

/*! Commits @p text to the focus object through an input method event (no key events). */
bool insertText(const QString &text, QString *error);

/*! Modifiers currently held down through keyDown() of a modifier key; they apply to all
 *  subsequent mouse and key events (like Playwright's keyboard.down('Shift')). */
Qt::KeyboardModifiers heldModifiers();

/*! Where the synthesized mouse pointer currently is (for drawing it into recordings). */
struct PointerState
{
    QWindow *window = nullptr; // null if no pointer input happened yet or the window is gone
    QPointF pos; // window coordinates
    Qt::MouseButtons buttons;
};
PointerState pointerState();

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
    /*! Runs @p step after the previously queued steps, waiting @p delayMs before it. */
    void enqueue(std::function<void()> step, int delayMs = 0);
    bool isIdle() const
    {
        return m_steps.empty();
    }

private:
    void runNext();

    QTimer m_timer;
    std::deque<std::pair<int, std::function<void()>>> m_steps;
};

}
}

#endif
