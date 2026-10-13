/*
  automationelement.cpp

  This file is part of GammaRay, the Qt application inspection and manipulation tool.

  SPDX-FileCopyrightText: 2026 Klarälvdalens Datakonsult AB, a KDAB Group company <info@kdab.com>

  SPDX-License-Identifier: GPL-2.0-or-later

  Contact KDAB at <info@kdab.com> for commercial licensing options.
*/

#include "automationelement.h"

#include <core/objectdataprovider.h>

#include <QGuiApplication>
#include <QMetaProperty>
#include <QRegularExpression>
#include <QSet>
#include <QWindow>

#include <private/qguiapplication_p.h>
#include <qpa/qwindowsysteminterface.h>

#ifdef QT_WIDGETS_LIB
#include <QAbstractButton>
#include <QApplication>
#include <QCheckBox>
#include <QRadioButton>
#include <QScrollArea>
#include <QStyle>
#include <QStyleOptionButton>
#include <QWidget>
#endif

#ifdef QT_QUICK_LIB
#include <QQmlContext>
#include <QQmlEngine>
#include <QQuickItem>
#include <QQuickRenderControl>
#include <QQuickWindow>
#endif

using namespace GammaRay;
using namespace GammaRay::Automation;

#ifdef QT_QUICK_LIB
// The window that actually receives platform input for a QQuickWindow (differs for QQuickWidget).
static QWindow *renderWindow(QQuickWindow *win, QPoint *offset = nullptr)
{
    if (!win)
        return nullptr;
    QPoint off;
    if (QWindow *rw = QQuickRenderControl::renderWindowFor(win, &off)) {
        if (offset)
            *offset = off;
        return rw;
    }
    if (offset)
        *offset = QPoint();
    return win;
}

static QQuickItem *popupItemOf(QObject *popup)
{
    auto content = popup->property("contentItem").value<QQuickItem *>();
    return content ? content->parentItem() : nullptr;
}
#endif

#ifdef QT_WIDGETS_LIB
static QWidget *widgetForWindow(QWindow *window)
{
    if (!window || !qobject_cast<QApplication *>(QCoreApplication::instance()))
        return nullptr;
    const auto widgets = QApplication::topLevelWidgets();
    for (QWidget *w : widgets) {
        if (w->windowHandle() == window)
            return w;
    }
    return nullptr;
}
#endif

QVector<QObject *> Element::children(QObject *obj)
{
    QVector<QObject *> result;
    QSet<QObject *> seen;
    auto add = [&](QObject *o) {
        if (o && !seen.contains(o)) {
            seen.insert(o);
            result.push_back(o);
        }
    };

#ifdef QT_QUICK_LIB
    if (auto win = qobject_cast<QQuickWindow *>(obj))
        add(win->contentItem());
    if (auto item = qobject_cast<QQuickItem *>(obj)) {
        // visual children first, in paint order
        const auto items = item->childItems();
        for (QQuickItem *child : items)
            add(child);
    }
    if (obj->inherits("QQuickPopup")) {
        // popup contents are reparented into the window overlay; follow them explicitly
        add(popupItemOf(obj));
    }
#endif

    const auto objs = obj->children();
    for (QObject *child : objs) {
#ifdef QT_QUICK_LIB
        // a QObject child that is visually parented elsewhere belongs to that visual subtree
        if (auto childItem = qobject_cast<QQuickItem *>(child)) {
            if (childItem->parentItem() && childItem->parentItem() != obj)
                continue;
        }
#endif
        add(child);
    }
    return result;
}

QObject *Element::parent(QObject *obj)
{
#ifdef QT_QUICK_LIB
    if (auto item = qobject_cast<QQuickItem *>(obj)) {
        if (item->parentItem()) {
            // a window's content item is a visual root, its logical parent is the window
            return item->parentItem();
        }
        if (item->window() && item->window()->contentItem() == item)
            return item->window();
    }
#endif
    return obj->parent();
}

bool Element::isSelfOrDescendantOf(QObject *obj, QObject *ancestor)
{
    int guard = 0;
    for (QObject *o = obj; o && guard < 1000; o = Element::parent(o), ++guard) {
        if (o == ancestor)
            return true;
#ifdef QT_QUICK_LIB
        // popup content: the popup item's logical owner is the popup object
        if (o->inherits("QQuickPopupItem") && ancestor->inherits("QQuickPopup") && popupItemOf(ancestor) == o)
            return true;
#endif
    }
    return false;
}

static const char *const s_textProperties[] = { "text", "plainText", "currentText", "title" };

static int textPropertyIndex(const QObject *obj)
{
    const QMetaObject *mo = obj->metaObject();
    for (const char *name : s_textProperties) {
        const int idx = mo->indexOfProperty(name);
        if (idx >= 0) {
            const QMetaProperty prop = mo->property(idx);
            const QMetaType mt = prop.metaType();
            if (mt.id() == QMetaType::QString || mt.id() == QMetaType::QVariant)
                return idx;
        }
    }
    return -1;
}

QString Element::textPropertyName(const QObject *obj)
{
    const int idx = textPropertyIndex(obj);
    return idx >= 0 ? QString::fromLatin1(obj->metaObject()->property(idx).name()) : QString();
}

bool Element::hasText(const QObject *obj)
{
    if (textPropertyIndex(obj) >= 0)
        return true;
#ifdef QT_WIDGETS_LIB
    if (auto w = qobject_cast<const QWidget *>(obj))
        return w->isWindow();
#endif
    return false;
}

QString Element::text(const QObject *obj)
{
    const int idx = textPropertyIndex(obj);
    if (idx >= 0)
        return obj->metaObject()->property(idx).read(obj).toString();
#ifdef QT_WIDGETS_LIB
    if (auto w = qobject_cast<const QWidget *>(obj)) {
        if (w->isWindow())
            return w->windowTitle();
    }
#endif
    return QString();
}

QString Element::qmlId(QObject *obj)
{
#ifdef QT_QUICK_LIB
    QQmlContext *ctx = QQmlEngine::contextForObject(obj);
    if (!ctx || !ctx->engine())
        return QString();
    return ctx->nameForObject(obj);
#else
    Q_UNUSED(obj);
    return QString();
#endif
}

static QString stripQmlSuffix(const QString &className)
{
    // QML-defined types get class names like "LoginForm_QMLTYPE_3" or "Main_QML_12"
    static const QRegularExpression re(QStringLiteral("_QML(TYPE)?_\\d+$"));
    QString s = className;
    s.remove(re);
    return s;
}

QStringList Element::typeNames(const QObject *obj)
{
    QStringList names;
    auto add = [&names](const QString &n) {
        if (!n.isEmpty() && !names.contains(n))
            names.push_back(n);
    };

    // QML type name as resolved by GammaRay's qmlsupport plugin, e.g. "QtQuick.Controls/Button"
    const QString qmlType = ObjectDataProvider::typeName(obj);
    if (qmlType != QLatin1String(obj->metaObject()->className())) {
        add(qmlType);
        add(qmlType.mid(qmlType.lastIndexOf(QLatin1Char('/')) + 1));
    }

    for (const QMetaObject *mo = obj->metaObject(); mo; mo = mo->superClass()) {
        const QString cls = QString::fromLatin1(mo->className());
        add(cls);
        const QString stripped = stripQmlSuffix(cls);
        add(stripped);
        if (stripped.startsWith(QLatin1String("QQuick")) && stripped.size() > 6)
            add(stripped.mid(6)); // QQuickButton -> Button
        const int ns = stripped.lastIndexOf(QLatin1String("::"));
        if (ns >= 0)
            add(stripped.mid(ns + 2));
    }
    return names;
}

QString Element::displayTypeName(const QObject *obj)
{
    const QString qmlType = ObjectDataProvider::typeName(obj);
    if (qmlType != QLatin1String(obj->metaObject()->className()))
        return qmlType.mid(qmlType.lastIndexOf(QLatin1Char('/')) + 1);
    return stripQmlSuffix(QString::fromLatin1(obj->metaObject()->className()));
}

bool Element::hasGeometry(const QObject *obj)
{
#ifdef QT_WIDGETS_LIB
    if (obj->isWidgetType())
        return true;
#endif
#ifdef QT_QUICK_LIB
    if (qobject_cast<const QQuickItem *>(obj))
        return true;
#endif
    return obj->isWindowType();
}

bool Element::isVisible(const QObject *obj)
{
#ifdef QT_WIDGETS_LIB
    if (auto w = qobject_cast<const QWidget *>(obj))
        return w->isVisible() && !w->size().isEmpty();
#endif
#ifdef QT_QUICK_LIB
    if (auto item = qobject_cast<const QQuickItem *>(obj)) {
        if (!item->isVisible() || item->width() <= 0 || item->height() <= 0)
            return false;
        QWindow *rw = renderWindow(item->window());
        if (!rw || !rw->isVisible())
            return false;
        for (const QQuickItem *i = item; i; i = i->parentItem()) {
            if (i->opacity() <= 0.0)
                return false;
        }
        return true;
    }
#endif
    if (auto window = qobject_cast<const QWindow *>(obj))
        return window->isVisible() && !window->size().isEmpty();
    return false;
}

bool Element::isEnabled(const QObject *obj)
{
#ifdef QT_WIDGETS_LIB
    if (auto w = qobject_cast<const QWidget *>(obj))
        return w->isEnabled();
#endif
#ifdef QT_QUICK_LIB
    if (auto item = qobject_cast<const QQuickItem *>(obj))
        return item->isEnabled();
#endif
    const int idx = obj->metaObject()->indexOfProperty("enabled");
    if (idx >= 0)
        return obj->metaObject()->property(idx).read(obj).toBool();
    return true;
}

QRectF Element::globalGeometry(const QObject *obj)
{
#ifdef QT_WIDGETS_LIB
    if (auto w = qobject_cast<const QWidget *>(obj))
        return QRectF(QPointF(w->mapToGlobal(QPoint(0, 0))), QSizeF(w->size()));
#endif
#ifdef QT_QUICK_LIB
    if (auto item = qobject_cast<const QQuickItem *>(obj)) {
        const QRectF scene = item->mapRectToScene(QRectF(0, 0, item->width(), item->height()));
        QPoint offset;
        QWindow *rw = renderWindow(item->window(), &offset);
        if (!rw)
            return scene;
        return QRectF(rw->mapToGlobal(scene.topLeft() + QPointF(offset)), scene.size());
    }
#endif
    if (auto window = qobject_cast<const QWindow *>(obj))
        return QRectF(window->geometry());
    return QRectF();
}

QSizeF Element::localSize(const QObject *obj)
{
#ifdef QT_WIDGETS_LIB
    if (auto w = qobject_cast<const QWidget *>(obj))
        return QSizeF(w->size());
#endif
#ifdef QT_QUICK_LIB
    if (auto item = qobject_cast<const QQuickItem *>(obj))
        return QSizeF(item->width(), item->height());
#endif
    if (auto window = qobject_cast<const QWindow *>(obj))
        return QSizeF(window->size());
    return QSizeF();
}

QPointF Element::defaultClickPosition(const QObject *obj)
{
#ifdef QT_WIDGETS_LIB
    // check boxes and radio buttons only react to clicks on their indicator and label,
    // which can be far from the center when the layout stretches the widget
    const bool isCheckBox = qobject_cast<const QCheckBox *>(obj);
    if (isCheckBox || qobject_cast<const QRadioButton *>(obj)) {
        auto button = static_cast<const QAbstractButton *>(obj);
        QStyleOptionButton opt;
        opt.initFrom(button);
        opt.text = button->text();
        opt.icon = button->icon();
        opt.iconSize = button->iconSize();
        const QRect r = button->style()->subElementRect(isCheckBox ? QStyle::SE_CheckBoxClickRect : QStyle::SE_RadioButtonClickRect, &opt, button);
        if (r.isValid())
            return QRectF(r).center();
    }
#endif
    const QSizeF size = localSize(obj);
    return QPointF(size.width() / 2.0, size.height() / 2.0);
}

Element::InputTarget Element::inputTarget(QObject *obj, QPointF localPos, QString *error)
{
    InputTarget t;
#ifdef QT_WIDGETS_LIB
    if (auto w = qobject_cast<QWidget *>(obj)) {
        QWidget *top = w->window();
        t.window = top->windowHandle();
        t.windowPos = w->mapTo(top, localPos);
        if (!t.window)
            *error = QStringLiteral("widget has no native window (is it shown?)");
        return t;
    }
#endif
#ifdef QT_QUICK_LIB
    if (auto item = qobject_cast<QQuickItem *>(obj)) {
        QPoint offset;
        t.window = renderWindow(item->window(), &offset);
        t.windowPos = item->mapToScene(localPos) + QPointF(offset);
        if (!t.window)
            *error = QStringLiteral("item is not in a window");
        return t;
    }
#endif
    if (auto window = qobject_cast<QWindow *>(obj)) {
        t.window = window;
        t.windowPos = localPos;
        return t;
    }
    *error = QStringLiteral("%1 is not a visual element").arg(QString::fromLatin1(obj->metaObject()->className()));
    return t;
}

static QString describe(const QObject *obj)
{
    QString s = Element::displayTypeName(obj);
    if (!obj->objectName().isEmpty())
        s += QLatin1Char('#') + obj->objectName();
    const QString t = Element::text(obj);
    if (!t.isEmpty())
        s += QStringLiteral(" \"%1\"").arg(t.left(40));
    return s;
}

QString Element::blockedBy(QObject *obj, QPointF localPos, const QVector<QObject *> &allObjects)
{
    QString error;
    const InputTarget t = inputTarget(obj, localPos, &error);
    if (!t.window)
        return error;

    QWindow *blockingWindow = nullptr;
    if (QGuiApplicationPrivate::instance()->isWindowBlocked(t.window, &blockingWindow)) {
        QObject *blocker = blockingWindow;
#ifdef QT_WIDGETS_LIB
        if (QWidget *w = widgetForWindow(blockingWindow))
            blocker = w;
#endif
        return QStringLiteral("modal window %1").arg(blocker ? describe(blocker) : QStringLiteral("(unknown)"));
    }

#ifdef QT_WIDGETS_LIB
    if (auto w = qobject_cast<QWidget *>(obj)) {
        QWidget *top = w->window();
        QWidget *hit = top->childAt(t.windowPos.toPoint());
        if (!hit)
            hit = top;
        if (hit != w && !w->isAncestorOf(hit))
            return describe(hit);
        return QString();
    }
#endif

#ifdef QT_QUICK_LIB
    if (auto item = qobject_cast<QQuickItem *>(obj)) {
        // pointer events only reach the parts of an item inside all clipping ancestors
        const QPointF scenePos = item->mapToScene(localPos);
        for (QQuickItem *p = item->parentItem(); p; p = p->parentItem()) {
            if (p->clip() && !p->contains(p->mapFromScene(scenePos)))
                return QStringLiteral("%1 (the point is outside its clipped area)").arg(describe(p));
        }
        for (QObject *o : allObjects) {
            if (!o->inherits("QQuickPopup") || !o->property("opened").toBool() || !o->property("modal").toBool())
                continue;
            QQuickItem *popupItem = popupItemOf(o);
            if (!popupItem || popupItem->window() != item->window())
                continue;
            if (!isSelfOrDescendantOf(item, popupItem))
                return QStringLiteral("modal popup %1").arg(describe(o));
        }
    }
#else
    Q_UNUSED(allObjects);
#endif
    return QString();
}

bool Element::scrollIntoView(QObject *obj)
{
    bool scrolled = false;
#ifdef QT_WIDGETS_LIB
    if (auto w = qobject_cast<QWidget *>(obj)) {
        for (QWidget *p = w->parentWidget(); p; p = p->parentWidget()) {
            if (auto area = qobject_cast<QScrollArea *>(p)) {
                if (area->widget() && area->widget()->isAncestorOf(w)) {
                    const QPoint before = area->widget()->pos();
                    area->ensureWidgetVisible(w, 0, 0);
                    scrolled |= area->widget()->pos() != before;
                }
            }
        }
        return scrolled;
    }
#endif
#ifdef QT_QUICK_LIB
    if (auto item = qobject_cast<QQuickItem *>(obj)) {
        for (QQuickItem *p = item->parentItem(); p; p = p->parentItem()) {
            if (!p->inherits("QQuickFlickable"))
                continue;
            auto content = p->property("contentItem").value<QQuickItem *>();
            if (!content || !content->isAncestorOf(item))
                continue;
            // item rect in content coordinates vs. the currently visible window of the content
            const QRectF r = item->mapRectToItem(content, QRectF(0, 0, item->width(), item->height()));
            auto adjust = [&](const char *posProp, const char *originProp, const char *extentProp, qreal viewSize,
                              qreal itemStart, qreal itemSize) {
                const qreal pos = p->property(posProp).toReal();
                const qreal origin = p->property(originProp).toReal();
                const qreal extent = p->property(extentProp).toReal();
                qreal target = pos;
                if (itemStart < pos)
                    target = itemStart;
                else if (itemStart + itemSize > pos + viewSize)
                    target = qMin(itemStart, itemStart + itemSize - viewSize);
                target = qBound(origin, target, qMax(origin, origin + extent - viewSize));
                if (!qFuzzyCompare(target + 1.0, pos + 1.0)) {
                    p->setProperty(posProp, target);
                    scrolled = true;
                }
            };
            adjust("contentY", "originY", "contentHeight", p->height(), r.y(), r.height());
            adjust("contentX", "originX", "contentWidth", p->width(), r.x(), r.width());
        }
    }
#endif
    Q_UNUSED(obj);
    return scrolled;
}

bool Element::focus(QObject *obj, QString *error)
{
#ifdef QT_WIDGETS_LIB
    if (auto w = qobject_cast<QWidget *>(obj)) {
        w->window()->activateWindow();
        QWindowSystemInterface::flushWindowSystemEvents();
        w->setFocus(Qt::OtherFocusReason);
        return true;
    }
#endif
#ifdef QT_QUICK_LIB
    if (auto item = qobject_cast<QQuickItem *>(obj)) {
        if (QWindow *rw = renderWindow(item->window())) {
            rw->requestActivate();
            QWindowSystemInterface::flushWindowSystemEvents();
        }
        item->forceActiveFocus(Qt::OtherFocusReason);
        return true;
    }
#endif
    if (auto window = qobject_cast<QWindow *>(obj)) {
        window->requestActivate();
        QWindowSystemInterface::flushWindowSystemEvents();
        return true;
    }
    *error = QStringLiteral("element cannot take focus");
    return false;
}

QImage Element::grab(QObject *obj, bool wholeWindow, QString *error)
{
#ifdef QT_WIDGETS_LIB
    if (auto w = qobject_cast<QWidget *>(obj))
        return (wholeWindow ? w->window() : w)->grab().toImage();
#endif
#ifdef QT_QUICK_LIB
    if (auto item = qobject_cast<QQuickItem *>(obj)) {
        QQuickWindow *win = item->window();
        if (!win) {
            *error = QStringLiteral("item is not in a window");
            return QImage();
        }
        QPoint offset;
        QWindow *rw = renderWindow(win, &offset);
#ifdef QT_WIDGETS_LIB
        if (rw != win) {
            // QQuickWidget: grab via the hosting widget so we get the composed result
            if (QWidget *host = widgetForWindow(rw)) {
                QImage img = host->grab().toImage();
                if (wholeWindow)
                    return img;
                const qreal dpr = img.devicePixelRatio();
                const QRectF r = item->mapRectToScene(QRectF(0, 0, item->width(), item->height())).translated(offset);
                return img.copy(QRectF(r.topLeft() * dpr, r.size() * dpr).toAlignedRect());
            }
        }
#endif
        QImage img = win->grabWindow();
        if (wholeWindow || item == win->contentItem())
            return img;
        const qreal dpr = img.devicePixelRatio();
        const QRectF r = item->mapRectToScene(QRectF(0, 0, item->width(), item->height()));
        return img.copy(QRectF(r.topLeft() * dpr, r.size() * dpr).toAlignedRect().intersected(img.rect()));
    }
    if (auto qwin = qobject_cast<QQuickWindow *>(obj))
        return qwin->grabWindow();
#endif
    if (auto window = qobject_cast<QWindow *>(obj)) {
#ifdef QT_WIDGETS_LIB
        if (QWidget *w = widgetForWindow(window))
            return w->grab().toImage();
#endif
        *error = QStringLiteral("cannot grab a %1").arg(QString::fromLatin1(window->metaObject()->className()));
        return QImage();
    }
    *error = QStringLiteral("%1 is not a visual element").arg(QString::fromLatin1(obj->metaObject()->className()));
    return QImage();
}

QString Element::windowTitle(const QObject *window)
{
#ifdef QT_WIDGETS_LIB
    if (auto w = qobject_cast<const QWidget *>(window))
        return w->windowTitle();
#endif
    if (auto w = qobject_cast<const QWindow *>(window))
        return w->title();
    return QString();
}

QVector<QObject *> Element::topLevelWindows(bool includePopups)
{
    QVector<QObject *> result;
#ifdef QT_WIDGETS_LIB
    if (qobject_cast<QApplication *>(QCoreApplication::instance())) {
        const auto widgets = QApplication::topLevelWidgets();
        for (QWidget *w : widgets) {
            const bool popup = w->windowType() == Qt::Popup || w->windowType() == Qt::ToolTip;
            if (w->isWindow() && w->isVisible() && (includePopups || !popup))
                result.push_back(w);
        }
    }
#endif
    const auto windows = QGuiApplication::topLevelWindows();
    for (QWindow *w : windows) {
        if (!w->isVisible() || w->inherits("QWidgetWindow"))
            continue;
#ifdef QT_QUICK_LIB
        if (auto qw = qobject_cast<QQuickWindow *>(w)) {
            if (renderWindow(qw) != qw)
                continue; // offscreen window of a QQuickWidget
        }
#endif
        result.push_back(w);
    }
    return result;
}
