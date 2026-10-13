/*
  automationinput.cpp

  This file is part of GammaRay, the Qt application inspection and manipulation tool.

  SPDX-FileCopyrightText: 2026 Klarälvdalens Datakonsult AB, a KDAB Group company <info@kdab.com>

  SPDX-License-Identifier: GPL-2.0-or-later

  Contact KDAB at <info@kdab.com> for commercial licensing options.
*/

#include "automationinput.h"

#include <QGuiApplication>
#include <QKeySequence>
#include <QPointer>
#include <QStyleHints>
#include <QWindow>

#include <private/qhighdpiscaling_p.h>
#include <qpa/qwindowsysteminterface.h>

// Exported by QtGui (used by QTest); delivers synchronously through QWindowSystemInterface.
Q_GUI_EXPORT void qt_handleMouseEvent(QWindow *window, const QPointF &local, const QPointF &global,
                                      Qt::MouseButtons state, Qt::MouseButton button,
                                      QEvent::Type type, Qt::KeyboardModifiers mods, int timestamp);
Q_GUI_EXPORT void qt_handleKeyEvent(QWindow *w, QEvent::Type t, int k, Qt::KeyboardModifiers mods,
                                    const QString &text = QString(), bool autorep = false, ushort count = 1);

using namespace GammaRay;
using namespace GammaRay::Automation;

namespace {
int s_timestamp = 1000;
Qt::MouseButtons s_buttons;
QPointer<QWindow> s_hoveredWindow;

void updateHoveredWindow(QWindow *window, QPointF pos)
{
    if (s_hoveredWindow == window)
        return;
    if (s_hoveredWindow)
        QWindowSystemInterface::handleLeaveEvent<QWindowSystemInterface::SynchronousDelivery>(s_hoveredWindow);
    s_hoveredWindow = window;
    QWindowSystemInterface::handleEnterEvent<QWindowSystemInterface::SynchronousDelivery>(
        window, QHighDpi::toNativeLocalPosition(pos, window),
        QHighDpi::toNativeGlobalPosition(window->mapToGlobal(pos), window));
}
}

void Input::mouseMove(QWindow *window, QPointF pos, Qt::KeyboardModifiers mods)
{
    updateHoveredWindow(window, pos);
    qt_handleMouseEvent(window, pos, window->mapToGlobal(pos), s_buttons, Qt::NoButton, QEvent::MouseMove, mods,
                        ++s_timestamp);
}

void Input::mousePress(QWindow *window, QPointF pos, Qt::MouseButton button, Qt::KeyboardModifiers mods)
{
    updateHoveredWindow(window, pos);
    s_buttons |= button;
    qt_handleMouseEvent(window, pos, window->mapToGlobal(pos), s_buttons, button, QEvent::MouseButtonPress, mods,
                        ++s_timestamp);
}

void Input::mouseRelease(QWindow *window, QPointF pos, Qt::MouseButton button, Qt::KeyboardModifiers mods,
                         bool endOfClick)
{
    s_buttons &= ~Qt::MouseButtons(button);
    if (!window)
        return; // target window vanished meanwhile; just forget the button state
    qt_handleMouseEvent(window, pos, window->mapToGlobal(pos), s_buttons, button, QEvent::MouseButtonRelease, mods,
                        ++s_timestamp);
    if (endOfClick)
        s_timestamp += QGuiApplication::styleHints()->mouseDoubleClickInterval() + 1;
}

void Input::wheel(QWindow *window, QPointF pos, QPoint angleDelta, Qt::KeyboardModifiers mods)
{
    updateHoveredWindow(window, pos);
    QWindowSystemInterface::handleWheelEvent(window, ++s_timestamp, QHighDpi::toNativeLocalPosition(pos, window),
                                             QHighDpi::toNativeGlobalPosition(window->mapToGlobal(pos), window),
                                             QPoint(), angleDelta, mods);
    QWindowSystemInterface::flushWindowSystemEvents();
}

void Input::keyPress(QWindow *window, int key, Qt::KeyboardModifiers mods, const QString &text)
{
    qt_handleKeyEvent(window, QEvent::KeyPress, key, mods, text);
}

void Input::keyRelease(QWindow *window, int key, Qt::KeyboardModifiers mods, const QString &text)
{
    if (!window)
        return;
    qt_handleKeyEvent(window, QEvent::KeyRelease, key, mods, text);
}

Input::KeySpec Input::keyForCharacter(QChar c)
{
    KeySpec spec;
    spec.text = QString(c);
    const QChar upper = c.toUpper();
    if (upper >= QLatin1Char('A') && upper <= QLatin1Char('Z'))
        spec.key = Qt::Key_A + (upper.unicode() - 'A');
    else if (c == QLatin1Char('\n'))
        spec.key = Qt::Key_Return, spec.text = QStringLiteral("\r");
    else if (c == QLatin1Char('\t'))
        spec.key = Qt::Key_Tab;
    else
        spec.key = upper.unicode(); // Qt::Key values equal Latin-1/Unicode code points for printable keys
    if (c.isUpper())
        spec.modifiers = Qt::ShiftModifier;
    return spec;
}

static int namedKey(const QString &name)
{
    struct Entry
    {
        const char *name;
        int key;
    };
    static const Entry entries[] = {
        { "Enter", Qt::Key_Return },
        { "Return", Qt::Key_Return },
        { "NumpadEnter", Qt::Key_Enter },
        { "Tab", Qt::Key_Tab },
        { "Escape", Qt::Key_Escape },
        { "Esc", Qt::Key_Escape },
        { "Backspace", Qt::Key_Backspace },
        { "Delete", Qt::Key_Delete },
        { "Insert", Qt::Key_Insert },
        { "Space", Qt::Key_Space },
        { "ArrowUp", Qt::Key_Up },
        { "ArrowDown", Qt::Key_Down },
        { "ArrowLeft", Qt::Key_Left },
        { "ArrowRight", Qt::Key_Right },
        { "Up", Qt::Key_Up },
        { "Down", Qt::Key_Down },
        { "Left", Qt::Key_Left },
        { "Right", Qt::Key_Right },
        { "Home", Qt::Key_Home },
        { "End", Qt::Key_End },
        { "PageUp", Qt::Key_PageUp },
        { "PageDown", Qt::Key_PageDown },
        { "Menu", Qt::Key_Menu },
    };
    for (const auto &e : entries) {
        if (name.compare(QLatin1String(e.name), Qt::CaseInsensitive) == 0)
            return e.key;
    }
    if (name.size() >= 2 && name.size() <= 3 && (name.at(0) == QLatin1Char('F') || name.at(0) == QLatin1Char('f'))) {
        bool ok = false;
        const int n = name.mid(1).toInt(&ok);
        if (ok && n >= 1 && n <= 35)
            return Qt::Key_F1 + n - 1;
    }
    return 0;
}

static Qt::KeyboardModifier namedModifier(const QString &name)
{
    if (name == QLatin1String("Shift"))
        return Qt::ShiftModifier;
    // ControlModifier is Cmd on macOS, matching Playwright's "ControlOrMeta" intent
    if (name == QLatin1String("Control") || name == QLatin1String("Ctrl") || name == QLatin1String("ControlOrMeta"))
        return Qt::ControlModifier;
    if (name == QLatin1String("Alt"))
        return Qt::AltModifier;
    if (name == QLatin1String("Meta"))
        return Qt::MetaModifier;
    return Qt::NoModifier;
}

bool Input::parseKey(const QString &spec, KeySpec *out, QString *error)
{
    // split on '+', but allow "+" itself as the final key ("Control++")
    QStringList parts;
    QString current;
    for (int i = 0; i < spec.size(); ++i) {
        const QChar c = spec.at(i);
        if (c == QLatin1Char('+') && !current.isEmpty()) {
            parts.push_back(current);
            current.clear();
        } else {
            current.push_back(c);
        }
    }
    parts.push_back(current);

    Qt::KeyboardModifiers mods;
    for (int i = 0; i < parts.size() - 1; ++i) {
        const auto m = namedModifier(parts.at(i));
        if (m == Qt::NoModifier) {
            *error = QStringLiteral("unknown modifier '%1' in \"%2\"").arg(parts.at(i), spec);
            return false;
        }
        mods |= m;
    }

    const QString keyName = parts.last();
    KeySpec result;
    if (keyName.size() == 1) {
        // a key name, not text to type: "Control+A" must not imply Shift
        result = keyForCharacter(keyName.at(0));
        result.modifiers = Qt::NoModifier;
    } else if (const int key = namedKey(keyName)) {
        result.key = key;
        if (key == Qt::Key_Return || key == Qt::Key_Enter)
            result.text = QStringLiteral("\r");
        else if (key == Qt::Key_Tab)
            result.text = QStringLiteral("\t");
        else if (key == Qt::Key_Space)
            result.text = QStringLiteral(" ");
        else if (key == Qt::Key_Backspace)
            result.text = QStringLiteral("\b");
        else if (key == Qt::Key_Escape)
            result.text = QString(QChar(0x1b));
        else if (key == Qt::Key_Delete)
            result.text = QString(QChar(0x7f));
    } else if (const auto m = namedModifier(keyName); m != Qt::NoModifier) {
        // pressing a modifier on its own
        result.key = m == Qt::ShiftModifier ? Qt::Key_Shift
            : m == Qt::ControlModifier      ? Qt::Key_Control
            : m == Qt::AltModifier          ? Qt::Key_Alt
                                            : Qt::Key_Meta;
    } else {
        const QKeySequence seq = QKeySequence::fromString(keyName, QKeySequence::PortableText);
        if (seq.isEmpty() || seq[0].key() == Qt::Key_unknown) {
            *error = QStringLiteral("unknown key '%1'").arg(keyName);
            return false;
        }
        result.key = seq[0].key();
        mods |= seq[0].keyboardModifiers();
    }
    result.modifiers |= mods;
    // with Control/Alt/Meta held the event carries no printable text (shortcut semantics)
    if (result.modifiers & (Qt::ControlModifier | Qt::AltModifier | Qt::MetaModifier))
        result.text.clear();
    *out = result;
    return true;
}

Qt::MouseButton Input::parseButton(const QString &name, bool *ok)
{
    *ok = true;
    if (name.isEmpty() || name == QLatin1String("left"))
        return Qt::LeftButton;
    if (name == QLatin1String("right"))
        return Qt::RightButton;
    if (name == QLatin1String("middle"))
        return Qt::MiddleButton;
    *ok = false;
    return Qt::NoButton;
}

Qt::KeyboardModifiers Input::parseModifiers(const QStringList &names, bool *ok)
{
    *ok = true;
    Qt::KeyboardModifiers mods;
    for (const auto &n : names) {
        const auto m = namedModifier(n);
        if (m == Qt::NoModifier)
            *ok = false;
        mods |= m;
    }
    return mods;
}

InputQueue::InputQueue(QObject *parent)
    : QObject(parent)
{
    m_timer.setSingleShot(true);
    m_timer.setInterval(0);
    connect(&m_timer, &QTimer::timeout, this, &InputQueue::runNext);
}

void InputQueue::enqueue(std::function<void()> step)
{
    m_steps.push_back(std::move(step));
    if (!m_timer.isActive())
        m_timer.start();
}

void InputQueue::runNext()
{
    if (m_steps.empty())
        return;
    auto step = std::move(m_steps.front());
    m_steps.pop_front();
    // re-arm first: if the step enters a nested event loop, the queue keeps going in there
    if (!m_steps.empty())
        m_timer.start();
    step();
}
