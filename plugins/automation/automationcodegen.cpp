/*
  automationcodegen.cpp

  This file is part of GammaRay, the Qt application inspection and manipulation tool.

  SPDX-FileCopyrightText: 2026 Klarälvdalens Datakonsult AB, a KDAB Group company <info@kdab.com>

  SPDX-License-Identifier: GPL-2.0-or-later

  Contact KDAB at <info@kdab.com> for commercial licensing options.
*/

#include "automationcodegen.h"
#include "automationelement.h"

#include <QCoreApplication>
#include <QJsonArray>
#include <QKeyEvent>
#include <QKeySequence>
#include <QMouseEvent>
#include <QTimer>
#include <QWindow>

#ifdef QT_WIDGETS_LIB
#include "automationitemview.h"

#include <QComboBox>
#include <QWidget>
#endif

#ifdef QT_QUICK_LIB
#include <QQuickItem>
#include <QQuickWindow>
#endif

#include <algorithm>

using namespace GammaRay;
using namespace GammaRay::Automation;

static bool isInteractiveRole(const QString &role)
{
    static const QStringList roles = { QStringLiteral("button"), QStringLiteral("checkbox"), QStringLiteral("radio"),
                                       QStringLiteral("textbox"), QStringLiteral("combobox"), QStringLiteral("slider"),
                                       QStringLiteral("spinbutton"), QStringLiteral("listitem"), QStringLiteral("tab"),
                                       QStringLiteral("menuitem"), QStringLiteral("link"), QStringLiteral("treeitem"),
                                       QStringLiteral("cell") };
    return roles.contains(role);
}

static QString keyName(int key, Qt::KeyboardModifiers mods)
{
    QString name;
    switch (key) {
    case Qt::Key_Return:
    case Qt::Key_Enter:
        name = QStringLiteral("Enter");
        break;
    case Qt::Key_Escape:
        name = QStringLiteral("Escape");
        break;
    case Qt::Key_Tab:
        name = QStringLiteral("Tab");
        break;
    case Qt::Key_Backtab:
        name = QStringLiteral("Tab");
        mods |= Qt::ShiftModifier;
        break;
    case Qt::Key_Backspace:
        name = QStringLiteral("Backspace");
        break;
    case Qt::Key_Delete:
        name = QStringLiteral("Delete");
        break;
    case Qt::Key_Up:
        name = QStringLiteral("ArrowUp");
        break;
    case Qt::Key_Down:
        name = QStringLiteral("ArrowDown");
        break;
    case Qt::Key_Left:
        name = QStringLiteral("ArrowLeft");
        break;
    case Qt::Key_Right:
        name = QStringLiteral("ArrowRight");
        break;
    case Qt::Key_Home:
        name = QStringLiteral("Home");
        break;
    case Qt::Key_End:
        name = QStringLiteral("End");
        break;
    case Qt::Key_PageUp:
        name = QStringLiteral("PageUp");
        break;
    case Qt::Key_PageDown:
        name = QStringLiteral("PageDown");
        break;
    case Qt::Key_Space:
        name = QStringLiteral("Space");
        break;
    default:
        if (key >= Qt::Key_F1 && key <= Qt::Key_F35)
            name = QStringLiteral("F%1").arg(key - Qt::Key_F1 + 1);
        else
            name = QKeySequence(key).toString(QKeySequence::PortableText);
        break;
    }
    QString prefix;
    if (mods & Qt::ControlModifier)
        prefix += QStringLiteral("Control+");
    if (mods & Qt::AltModifier)
        prefix += QStringLiteral("Alt+");
    if (mods & Qt::MetaModifier)
        prefix += QStringLiteral("Meta+");
    if (mods & Qt::ShiftModifier)
        prefix += QStringLiteral("Shift+");
    return prefix + name;
}

ActionRecorder::ActionRecorder(LocatorFactory locator, ActionSink sink, ObjectFilter accept, QObject *parent)
    : QObject(parent)
    , m_locator(std::move(locator))
    , m_sink(std::move(sink))
    , m_accept(std::move(accept))
{
    QCoreApplication::instance()->installEventFilter(this);
}

ActionRecorder::~ActionRecorder()
{
    if (auto app = QCoreApplication::instance())
        app->removeEventFilter(this);
}

QObject *ActionRecorder::meaningfulAncestor(QObject *obj) const
{
    // the closest interactive control (a Button rather than the Text inside it) ...
    for (QObject *o = obj; o; o = Element::parent(o)) {
        if (o->isWindowType())
            break;
        const auto acc = Element::accessible(o);
        if (acc.valid && isInteractiveRole(acc.role))
            return o;
    }
    // ... else the closest object with a name
    for (QObject *o = obj; o; o = Element::parent(o)) {
        if (o->isWindowType())
            break;
        if ((!o->objectName().isEmpty() && !o->objectName().startsWith(QLatin1String("qt_"))) || !Element::qmlId(o).isEmpty())
            return o;
    }
    return obj;
}

#ifdef QT_QUICK_LIB
static QQuickItem *deepestItemAt(QQuickItem *item, QPointF scenePos)
{
    if (!item->isVisible() || !item->isEnabled())
        return nullptr;
    auto children = item->childItems();
    std::stable_sort(children.begin(), children.end(), [](QQuickItem *a, QQuickItem *b) { return a->z() < b->z(); });
    for (auto it = children.crbegin(); it != children.crend(); ++it) {
        if (QQuickItem *hit = deepestItemAt(*it, scenePos))
            return hit;
    }
    if (item->contains(item->mapFromScene(scenePos)) && item->width() > 0 && item->height() > 0)
        return item;
    return nullptr;
}
#endif

QObject *ActionRecorder::pointerTarget(QObject *receiver, QPointF windowPos) const
{
#ifdef QT_QUICK_LIB
    if (auto window = qobject_cast<QQuickWindow *>(receiver)) {
        QQuickItem *root = window->contentItem()->parentItem() ? window->contentItem()->parentItem() : window->contentItem();
        if (QQuickItem *hit = deepestItemAt(root, windowPos))
            return meaningfulAncestor(hit);
        return nullptr;
    }
#else
    Q_UNUSED(windowPos);
#endif
#ifdef QT_WIDGETS_LIB
    if (receiver->isWidgetType()) {
        // item view rows have no widgets: use the row (or table cell) under the pointer
        if (QAbstractItemView *view = ViewItems::viewForViewport(static_cast<QWidget *>(receiver))) {
            if (ViewItem *item = ViewItems::itemAt(view, windowPos.toPoint()))
                return item;
        }
        return meaningfulAncestor(receiver);
    }
#endif
    return nullptr;
}

bool ActionRecorder::isCheckedRow(QObject *obj)
{
#ifdef QT_WIDGETS_LIB
    if (auto item = qobject_cast<ViewItem *>(obj))
        return item->isChecked();
#endif
    Q_UNUSED(obj);
    return false;
}

void ActionRecorder::emitAction(const QString &action, QObject *target, const QJsonObject &extra)
{
    if (!target)
        return;
    QJsonObject a = extra;
    a.insert(QStringLiteral("action"), action);
    a.insert(QStringLiteral("target"), m_locator(target));
    m_sink(a);
}

void ActionRecorder::flush()
{
    if (!m_typingTarget)
        return;
    QObject *target = m_typingTarget;
    m_typingTarget = nullptr;
    emitAction(QStringLiteral("fill"), target, { { QStringLiteral("value"), Element::text(target) } });
}

void ActionRecorder::handleRelease(QObject *target, QPointF globalPos, QObject *releaseTarget)
{
    if (target != m_typingTarget)
        flush();

    // drags: pressed on one element, released somewhere else
    if (m_pressTarget && (globalPos - m_pressGlobalPos).manhattanLength() > 8) {
        const QPointF delta = globalPos - m_pressGlobalPos;
        const QPointF grab = m_pressLocalPos;
        const QJsonObject source { { QStringLiteral("x"), qRound(grab.x()) }, { QStringLiteral("y"), qRound(grab.y()) } };
        if (releaseTarget && releaseTarget != m_pressTarget.data()) {
            emitAction(QStringLiteral("dragTo"), m_pressTarget,
                       { { QStringLiteral("to"), m_locator(releaseTarget) }, { QStringLiteral("sourcePosition"), source } });
        } else {
            emitAction(QStringLiteral("dragBy"), m_pressTarget,
                       { { QStringLiteral("dx"), qRound(delta.x()) },
                         { QStringLiteral("dy"), qRound(delta.y()) },
                         { QStringLiteral("sourcePosition"), source } });
        }
        return;
    }

#ifdef QT_WIDGETS_LIB
    // QComboBox popup: report the resulting selection instead of a click into the list
    if (m_comboPopup) {
        QObject *c = target;
        if (auto row = qobject_cast<ViewItem *>(target))
            c = row->view(); // the popup list's rows belong to the combo box's view
        while (c && !qobject_cast<QComboBox *>(c))
            c = c->parent();
        const QPointer<QComboBox> combo(qobject_cast<QComboBox *>(c));
        QTimer::singleShot(0, this, [this, combo]() {
            if (combo)
                emitAction(QStringLiteral("selectOption"), combo, { { QStringLiteral("value"), combo->currentText() } });
        });
        return;
    }
#endif
#ifdef QT_QUICK_LIB
    // QML ComboBox popup delegates
    if (auto item = qobject_cast<QQuickItem *>(target)) {
        for (QQuickItem *p = item; p; p = p->parentItem()) {
            if (!p->inherits("QQuickPopupItem"))
                continue;
            QObject *popup = p->parent();
            QObject *combo = popup ? popup->parent() : nullptr;
            if (combo && combo->inherits("QQuickComboBox")) {
                // read the result once the delegate processed the click
                const QPointer<QObject> c(combo);
                QTimer::singleShot(0, this, [this, c]() {
                    if (c)
                        emitAction(QStringLiteral("selectOption"), c, { { QStringLiteral("value"), c->property("currentText").toString() } });
                });
                return;
            }
            break;
        }
    }
#endif

#ifdef QT_WIDGETS_LIB
    // a click on the check box of an item view row: check()/uncheck(), else a (modified) click
    if (auto item = qobject_cast<ViewItem *>(target)) {
        const QPointer<ViewItem> row(item);
        const bool wasChecked = m_pressChecked;
        // a click left of the row (on a tree's expand/collapse arrow) needs its position
        QJsonObject extra;
        if (m_pressLocalPos.x() < 0)
            extra.insert(QStringLiteral("position"), QJsonObject { { QStringLiteral("x"), qRound(m_pressLocalPos.x()) }, { QStringLiteral("y"), qRound(m_pressLocalPos.y()) } });
        QStringList modifiers;
        if (m_pressModifiers & Qt::ControlModifier)
            modifiers.push_back(QStringLiteral("Control"));
        if (m_pressModifiers & Qt::ShiftModifier)
            modifiers.push_back(QStringLiteral("Shift"));
        if (m_pressModifiers & Qt::AltModifier)
            modifiers.push_back(QStringLiteral("Alt"));
        if (!modifiers.isEmpty())
            extra.insert(QStringLiteral("modifiers"), QJsonArray::fromStringList(modifiers));
        QTimer::singleShot(0, this, [this, row, wasChecked, extra]() {
            if (!row)
                return;
            if (row->isCheckable() && row->isChecked() != wasChecked)
                emitAction(row->isChecked() ? QStringLiteral("check") : QStringLiteral("uncheck"), row);
            else
                emitAction(QStringLiteral("click"), row, extra);
        });
        return;
    }
#endif

    const auto acc = Element::accessible(target);
    if (acc.valid && (acc.role == QLatin1String("checkbox") || acc.role == QLatin1String("radio"))) {
        // report the resulting state once the click has been processed
        const QPointer<QObject> t(target);
        QTimer::singleShot(0, this, [this, t]() {
            if (t)
                emitAction(t->property("checked").toBool() ? QStringLiteral("check") : QStringLiteral("uncheck"), t);
        });
        return;
    }
    emitAction(QStringLiteral("click"), target);
}

bool ActionRecorder::eventFilter(QObject *receiver, QEvent *event)
{
    const int type = event->type();
    const bool mouse = type == QEvent::MouseButtonPress || type == QEvent::MouseButtonRelease || type == QEvent::MouseButtonDblClick;
    const bool key = type == QEvent::KeyPress;
    if (!mouse && !key && type != QEvent::FocusOut && type != QEvent::KeyRelease)
        return false;

    if (type == QEvent::FocusOut) {
        if (receiver == m_typingTarget.data())
            flush();
        return false;
    }

    // only look at deliveries we handle: the same event object is delivered again when it
    // is forwarded (window -> focus widget) or propagates to parents
    if (mouse) {
        // QWidgetWindow forwards a copy to the widget; Qt Quick: hit test at the window
        if (receiver->inherits("QWidgetWindow") || (receiver->isWindowType() && !receiver->inherits("QQuickWindow")))
            return false;
#ifdef QT_QUICK_LIB
        if (qobject_cast<QQuickItem *>(receiver))
            return false;
#endif
    } else if (receiver->isWindowType()) {
        return false; // keys: the focus widget / active focus item gets the same event next
    }
    if (event == m_lastEvent && type == m_lastEventType)
        return false;
    m_lastEvent = event;
    m_lastEventType = type;
    if (type == QEvent::KeyRelease)
        return false;

    if (mouse) {
        auto me = static_cast<QMouseEvent *>(event);
        QObject *target = pointerTarget(receiver, me->position());
        if (!target || !m_accept(target))
            return false;
        const QPointF global = me->globalPosition();
        if (type == QEvent::MouseButtonPress) {
            m_pressTarget = target;
            m_pressGlobalPos = global;
            m_pressLocalPos = global - Element::globalGeometry(target).topLeft();
            m_pressModifiers = me->modifiers();
            m_pressChecked = isCheckedRow(target);
#ifdef QT_WIDGETS_LIB
            // clicks into a QComboBox's popup list are recorded as selectOption on release
            auto w = qobject_cast<QWidget *>(receiver);
            m_comboPopup = w && w->window() && w->window()->inherits("QComboBoxPrivateContainer");
#endif
        } else if (type == QEvent::MouseButtonDblClick) {
            flush();
            emitAction(QStringLiteral("dblclick"), target);
            m_pressTarget = nullptr; // the release that follows is part of the double click
        } else if (m_pressTarget) {
            handleRelease(m_pressTarget, global, target);
            m_pressTarget = nullptr;
        }
        return false;
    }

    // keys go to the focus widget / active focus item
    auto ke = static_cast<QKeyEvent *>(event);
    QObject *target = meaningfulAncestor(receiver);
    if (!target || !m_accept(target))
        return false;
    const int k = ke->key();
    if (k == Qt::Key_Shift || k == Qt::Key_Control || k == Qt::Key_Alt || k == Qt::Key_Meta || k == Qt::Key_unknown)
        return false;
    const bool editable = Element::editableState(target) >= 0;
    const bool commandKey = k == Qt::Key_Return || k == Qt::Key_Enter || k == Qt::Key_Escape || k == Qt::Key_Tab
        || k == Qt::Key_Backtab || k == Qt::Key_Up || k == Qt::Key_Down || k == Qt::Key_PageUp || k == Qt::Key_PageDown;
    if (editable && !commandKey) {
        // editing: recorded as a single fill() with the resulting text
        if (m_typingTarget != target) {
            flush();
            m_typingTarget = target;
        }
        return false;
    }
    flush();
    emitAction(QStringLiteral("press"), target,
               { { QStringLiteral("key"), keyName(k, ke->modifiers() & ~Qt::KeypadModifier) } });
    return false;
}
