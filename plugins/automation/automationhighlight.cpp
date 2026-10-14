/*
  automationhighlight.cpp

  This file is part of GammaRay, the Qt application inspection and manipulation tool.

  SPDX-FileCopyrightText: 2026 Klarälvdalens Datakonsult AB, a KDAB Group company <info@kdab.com>

  SPDX-License-Identifier: GPL-2.0-or-later

  Contact KDAB at <info@kdab.com> for commercial licensing options.
*/

#include "automationhighlight.h"
#include "automationelement.h"

#include <core/probeguard.h>

#include <QHash>
#include <QWindow>

#ifdef QT_WIDGETS_LIB
#include <QPaintEvent>
#include <QPainter>
#include <QWidget>
#endif

#ifdef QT_QUICK_LIB
#include <QQuickItem>
#include <QQuickWindow>
#include <QSGRectangleNode>
#endif

using namespace GammaRay;
using namespace GammaRay::Automation;

static const char *const OverlayName = "qt_playwright_highlight";

#ifdef QT_WIDGETS_LIB
namespace {
class WidgetOverlay : public QWidget
{
public:
    WidgetOverlay(QWidget *window, const QVector<Highlighter::Box> &boxes, const QColor &color)
        : QWidget(window)
        , m_boxes(boxes)
        , m_color(color)
    {
        setObjectName(QLatin1String(OverlayName));
        setAttribute(Qt::WA_TransparentForMouseEvents);
        setAttribute(Qt::WA_NoSystemBackground);
        setFocusPolicy(Qt::NoFocus);
        setGeometry(window->rect());
        raise();
        show();
    }

protected:
    void paintEvent(QPaintEvent *) override
    {
        QPainter p(this);
        for (const auto &box : std::as_const(m_boxes)) {
            const QRectF r(QPointF(mapFromGlobal(box.global.topLeft().toPoint())), box.global.size());
            QColor fill = m_color;
            fill.setAlpha(110);
            p.fillRect(r, fill);
            p.setPen(QPen(m_color.darker(130), 1));
            p.drawRect(r.adjusted(0, 0, -1, -1));
            if (box.label.isEmpty())
                continue;
            // a tooltip-like label above the box, like Playwright's
            QFont font = p.font();
            font.setPixelSize(11);
            p.setFont(font);
            const QRectF text = p.boundingRect(QRectF(0, 0, 600, 40), Qt::AlignLeft | Qt::AlignTop, box.label).adjusted(-4, -2, 4, 2);
            QRectF label = text.translated(r.left() - text.left(), r.top() - text.height() - 2);
            if (label.top() < 0)
                label.moveTop(r.bottom() + 2);
            p.fillRect(label, QColor(255, 255, 255, 235));
            p.setPen(QColor(51, 51, 51));
            p.drawText(label, Qt::AlignCenter, box.label);
        }
    }

private:
    QVector<Highlighter::Box> m_boxes;
    QColor m_color;
};
}
#endif

#ifdef QT_QUICK_LIB
namespace {
class QuickOverlay : public QQuickItem
{
public:
    QuickOverlay(QQuickWindow *window, const QVector<Highlighter::Box> &boxes, const QColor &color)
        : QQuickItem(window->contentItem())
        , m_boxes(boxes)
        , m_color(color)
    {
        setObjectName(QLatin1String(OverlayName));
        setFlag(ItemHasContents);
        setAcceptedMouseButtons(Qt::NoButton);
        setZ(1e9);
        setSize(window->contentItem()->size());
        update();
    }

protected:
    QSGNode *updatePaintNode(QSGNode *old, UpdatePaintNodeData *) override
    {
        delete old;
        auto root = new QSGNode;
        QColor fill = m_color;
        fill.setAlpha(110);
        for (const auto &box : std::as_const(m_boxes)) {
            const QPointF topLeft = mapFromGlobal(box.global.topLeft());
            QSGRectangleNode *rect = window()->createRectangleNode();
            rect->setRect(QRectF(topLeft, box.global.size()));
            rect->setColor(fill);
            root->appendChildNode(rect);
        }
        return root;
    }

private:
    QVector<Highlighter::Box> m_boxes;
    QColor m_color;
};
}
#endif

Highlighter::Highlighter(QObject *parent)
    : QObject(parent)
{
}

Highlighter::~Highlighter()
{
    hide();
}

static QObject *windowOf(QObject *obj)
{
    const auto windows = Element::topLevelWindows(true);
    for (QObject *o = obj; o; o = Element::parent(o)) {
        if (windows.contains(o))
            return o;
#ifdef QT_QUICK_LIB
        if (auto item = qobject_cast<QQuickItem *>(o))
            return item->window();
#endif
#ifdef QT_WIDGETS_LIB
        if (auto w = qobject_cast<QWidget *>(o))
            return w->window();
#endif
    }
    return nullptr;
}

void Highlighter::show(const QVector<QObject *> &elements, const QString &label, const QColor &color)
{
    hide();
    QHash<QObject *, QVector<Box>> perWindow;
    QVector<QObject *> order;
    for (QObject *obj : elements) {
        if (!Element::hasGeometry(obj) || !Element::isVisible(obj))
            continue;
        QObject *window = windowOf(obj);
        if (!window)
            continue;
        if (!perWindow.contains(window))
            order.push_back(window);
        perWindow[window].push_back({ Element::globalGeometry(obj), label });
    }

    ProbeGuard guard; // overlays are not application objects
    for (QObject *window : std::as_const(order)) {
        const auto &boxes = perWindow.value(window);
#ifdef QT_WIDGETS_LIB
        if (auto w = qobject_cast<QWidget *>(window)) {
            m_overlays.push_back(new WidgetOverlay(w, boxes, color));
            continue;
        }
#endif
#ifdef QT_QUICK_LIB
        if (auto qw = qobject_cast<QQuickWindow *>(window)) {
            m_overlays.push_back(new QuickOverlay(qw, boxes, color));
            continue;
        }
#endif
    }
}

void Highlighter::hide()
{
    for (const auto &overlay : std::as_const(m_overlays))
        delete overlay.data();
    m_overlays.clear();
}
