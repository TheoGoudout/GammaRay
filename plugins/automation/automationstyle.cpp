/*
  automationstyle.cpp

  This file is part of GammaRay, the Qt application inspection and manipulation tool.

  SPDX-FileCopyrightText: 2026 Klarälvdalens Datakonsult AB, a KDAB Group company <info@kdab.com>

  SPDX-License-Identifier: GPL-2.0-or-later

  Contact KDAB at <info@kdab.com> for commercial licensing options.
*/

#include "automationstyle.h"
#include "automationelement.h"

#include <QColor>
#include <QCursor>
#include <QFont>
#include <QGuiApplication>
#include <QScreen>
#include <QVariant>
#include <QWindow>

#ifdef QT_WIDGETS_LIB
#include "automationitemview.h"

#include <QAbstractItemView>
#include <QComboBox>
#include <QGraphicsOpacityEffect>
#include <QItemSelectionModel>
#include <QTableView>
#include <QWidget>
#endif

#ifdef QT_QUICK_LIB
#include <QQuickItem>
#endif

#include <algorithm>

using namespace GammaRay;
using namespace GammaRay::Automation;

static QString px(qreal v)
{
    return QString::number(v, 'g', 6) + QStringLiteral("px");
}

QString Style::cssColor(const QColor &color)
{
    const QColor c = color.toRgb();
    if (c.alpha() == 255)
        return QStringLiteral("rgb(%1, %2, %3)").arg(c.red()).arg(c.green()).arg(c.blue());
    return QStringLiteral("rgba(%1, %2, %3, %4)").arg(c.red()).arg(c.green()).arg(c.blue()).arg(QString::number(c.alphaF(), 'g', 3));
}

static void addFont(QJsonObject &css, const QFont &font, qreal dpi)
{
    css.insert(QStringLiteral("font-family"), font.family());
    qreal size = font.pixelSize();
    if (size <= 0)
        size = font.pointSizeF() * dpi / 72.0;
    css.insert(QStringLiteral("font-size"), px(qRound(size * 100) / 100.0));
    css.insert(QStringLiteral("font-weight"), QString::number(int(font.weight())));
    css.insert(QStringLiteral("font-style"), font.italic() ? QStringLiteral("italic") : QStringLiteral("normal"));
    QStringList decoration;
    if (font.underline())
        decoration.push_back(QStringLiteral("underline"));
    if (font.overline())
        decoration.push_back(QStringLiteral("overline"));
    if (font.strikeOut())
        decoration.push_back(QStringLiteral("line-through"));
    css.insert(QStringLiteral("text-decoration-line"), decoration.isEmpty() ? QStringLiteral("none") : decoration.join(QLatin1Char(' ')));
    css.insert(QStringLiteral("letter-spacing"), font.letterSpacing() == 0 ? QStringLiteral("normal") : px(font.letterSpacing()));
}

static QString cssCursor(Qt::CursorShape shape)
{
    switch (shape) {
    case Qt::PointingHandCursor:
        return QStringLiteral("pointer");
    case Qt::IBeamCursor:
        return QStringLiteral("text");
    case Qt::WaitCursor:
        return QStringLiteral("wait");
    case Qt::BusyCursor:
        return QStringLiteral("progress");
    case Qt::CrossCursor:
        return QStringLiteral("crosshair");
    case Qt::ForbiddenCursor:
        return QStringLiteral("not-allowed");
    case Qt::WhatsThisCursor:
        return QStringLiteral("help");
    case Qt::SizeAllCursor:
        return QStringLiteral("move");
    case Qt::SizeHorCursor:
    case Qt::SplitHCursor:
        return QStringLiteral("ew-resize");
    case Qt::SizeVerCursor:
    case Qt::SplitVCursor:
        return QStringLiteral("ns-resize");
    case Qt::SizeBDiagCursor:
        return QStringLiteral("nesw-resize");
    case Qt::SizeFDiagCursor:
        return QStringLiteral("nwse-resize");
    case Qt::OpenHandCursor:
        return QStringLiteral("grab");
    case Qt::ClosedHandCursor:
        return QStringLiteral("grabbing");
    case Qt::BlankCursor:
        return QStringLiteral("none");
    default:
        return QStringLiteral("auto");
    }
}

static qreal dpiOf(QObject *obj)
{
#ifdef QT_WIDGETS_LIB
    if (auto w = qobject_cast<QWidget *>(obj))
        return w->logicalDpiY();
#endif
    QScreen *screen = QGuiApplication::primaryScreen();
    return screen ? screen->logicalDotsPerInchY() : 96.0;
}

static void addGeometry(QJsonObject &css, QObject *obj)
{
    const QSizeF size = Element::localSize(obj);
    css.insert(QStringLiteral("width"), px(size.width()));
    css.insert(QStringLiteral("height"), px(size.height()));
    const bool visible = Element::isVisible(obj);
    css.insert(QStringLiteral("visibility"), visible ? QStringLiteral("visible") : QStringLiteral("hidden"));
    css.insert(QStringLiteral("display"), visible ? QStringLiteral("block") : QStringLiteral("none"));
}

#ifdef QT_WIDGETS_LIB
static void widgetStyle(QJsonObject &css, QWidget *w)
{
    w->ensurePolished(); // style sheets reach the palette and font when the widget is polished
    const QPalette &pal = w->palette();
    const QPalette::ColorGroup group = w->isEnabled() ? (w->isActiveWindow() ? QPalette::Active : QPalette::Inactive) : QPalette::Disabled;
    css.insert(QStringLiteral("color"), Style::cssColor(pal.color(group, w->foregroundRole())));
    // like browsers, a widget that doesn't paint its background is transparent
    bool paletteSetsBackground = false;
    for (int g = 0; g < 3; ++g) // explicitly set background color (QPalette's resolve bit layout)
        paletteSetsBackground |= w->palette().resolveMask() & (quint64(1) << (int(w->backgroundRole()) + QPalette::NColorRoles * g));
    const bool paintsBackground = w->autoFillBackground() || w->isWindow() || w->testAttribute(Qt::WA_StyledBackground) || paletteSetsBackground;
    css.insert(QStringLiteral("background-color"),
               paintsBackground ? Style::cssColor(pal.color(group, w->backgroundRole())) : QStringLiteral("rgba(0, 0, 0, 0)"));
    addFont(css, w->font(), w->logicalDpiY());
    qreal opacity = w->isWindow() ? w->windowOpacity() : 1.0;
    if (auto effect = qobject_cast<QGraphicsOpacityEffect *>(w->graphicsEffect()))
        opacity *= effect->opacity();
    css.insert(QStringLiteral("opacity"), QString::number(opacity, 'g', 3));
    css.insert(QStringLiteral("cursor"), w->testAttribute(Qt::WA_SetCursor) ? cssCursor(w->cursor().shape()) : QStringLiteral("auto"));
    css.insert(QStringLiteral("pointer-events"), w->testAttribute(Qt::WA_TransparentForMouseEvents) ? QStringLiteral("none") : QStringLiteral("auto"));
    css.insert(QStringLiteral("direction"), w->layoutDirection() == Qt::RightToLeft ? QStringLiteral("rtl") : QStringLiteral("ltr"));
    if (!w->styleSheet().isEmpty())
        css.insert(QStringLiteral("-qt-style-sheet"), w->styleSheet());
}

static void viewItemStyle(QJsonObject &css, ViewItem *item)
{
    if (!item->isValid())
        return;
    const QModelIndex index = item->index();
    const QPalette &pal = item->view()->palette();
    const QVariant fg = index.data(Qt::ForegroundRole);
    const QVariant bg = index.data(Qt::BackgroundRole);
    css.insert(QStringLiteral("color"),
               Style::cssColor(fg.isValid() ? fg.value<QBrush>().color() : pal.color(item->isSelected() ? QPalette::HighlightedText : QPalette::Text)));
    css.insert(QStringLiteral("background-color"),
               bg.isValid() ? Style::cssColor(bg.value<QBrush>().color())
                            : (item->isSelected() ? Style::cssColor(pal.color(QPalette::Highlight)) : QStringLiteral("rgba(0, 0, 0, 0)")));
    const QVariant font = index.data(Qt::FontRole);
    addFont(css, font.isValid() ? font.value<QFont>() : item->view()->font(), item->view()->logicalDpiY());
    const QVariant align = index.data(Qt::TextAlignmentRole);
    if (align.isValid()) {
        const int a = align.toInt();
        css.insert(QStringLiteral("text-align"),
                   (a & Qt::AlignRight) ? QStringLiteral("right") : (a & Qt::AlignHCenter) ? QStringLiteral("center")
                                                                                           : QStringLiteral("left"));
    }
    css.insert(QStringLiteral("opacity"), QStringLiteral("1"));
}
#endif

#ifdef QT_QUICK_LIB
static QString colorProperty(QObject *obj, const char *name)
{
    if (!obj)
        return QString();
    const QVariant v = obj->property(name);
    if (v.metaType().id() == QMetaType::QColor)
        return Style::cssColor(v.value<QColor>());
    return QString();
}

static void quickStyle(QJsonObject &css, QQuickItem *item)
{
    // Text/Label: color; Rectangle: color is its background; Controls: palette + background item
    const bool isText = item->metaObject()->indexOfProperty("font") >= 0 && item->metaObject()->indexOfProperty("text") >= 0;
    const QString ownColor = colorProperty(item, "color");
    auto background = item->property("background").value<QQuickItem *>();
    QString bg = background ? colorProperty(background, "color") : QString();
    if (!isText && !ownColor.isEmpty() && bg.isEmpty())
        bg = ownColor; // a Rectangle
    css.insert(QStringLiteral("background-color"), bg.isEmpty() ? QStringLiteral("rgba(0, 0, 0, 0)") : bg);
    QString fg = isText ? ownColor : QString();
    if (fg.isEmpty()) {
        if (auto content = item->property("contentItem").value<QQuickItem *>())
            fg = colorProperty(content, "color");
    }
    if (fg.isEmpty()) {
        const QVariant palette = item->property("palette");
        if (palette.isValid() && palette.canConvert<QPalette>())
            fg = Style::cssColor(palette.value<QPalette>().color(QPalette::WindowText));
    }
    if (!fg.isEmpty())
        css.insert(QStringLiteral("color"), fg);
    const QVariant font = item->property("font");
    if (font.isValid() && font.canConvert<QFont>())
        addFont(css, font.value<QFont>(), dpiOf(item));
    qreal opacity = 1.0;
    for (QQuickItem *i = item; i; i = i->parentItem())
        opacity *= i->opacity();
    css.insert(QStringLiteral("opacity"), QString::number(opacity, 'g', 3));
    QObject *borderOwner = (!isText && !ownColor.isEmpty()) ? item : background;
    if (borderOwner) {
        if (auto border = borderOwner->property("border").value<QObject *>()) {
            css.insert(QStringLiteral("border-color"), colorProperty(border, "color"));
            css.insert(QStringLiteral("border-width"), px(border->property("width").toReal()));
        }
        const QVariant radius = borderOwner->property("radius");
        if (radius.isValid())
            css.insert(QStringLiteral("border-radius"), px(radius.toReal()));
    }
    css.insert(QStringLiteral("cursor"), cssCursor(item->cursor().shape()));
    css.insert(QStringLiteral("z-index"), QString::number(item->z(), 'g', 6));
    css.insert(QStringLiteral("transform"), qFuzzyIsNull(item->rotation()) && qFuzzyCompare(item->scale(), 1.0) ? QStringLiteral("none") : QStringLiteral("rotate(%1deg) scale(%2)").arg(item->rotation()).arg(item->scale()));
}
#endif

QJsonObject Style::computed(QObject *obj)
{
    QJsonObject css;
    if (Element::hasGeometry(obj))
        addGeometry(css, obj);
#ifdef QT_WIDGETS_LIB
    if (auto w = qobject_cast<QWidget *>(obj))
        widgetStyle(css, w);
    else if (auto item = qobject_cast<ViewItem *>(obj))
        viewItemStyle(css, item);
#endif
#ifdef QT_QUICK_LIB
    if (auto item = qobject_cast<QQuickItem *>(obj))
        quickStyle(css, item);
#endif
    if (auto window = qobject_cast<QWindow *>(obj))
        css.insert(QStringLiteral("opacity"), QString::number(window->opacity(), 'g', 3));
    return css;
}

QStringList Style::selectedValues(QObject *obj, bool *ok)
{
    *ok = true;
#ifdef QT_WIDGETS_LIB
    if (auto combo = qobject_cast<QComboBox *>(obj))
        return combo->currentIndex() >= 0 ? QStringList { combo->currentText() } : QStringList();
    if (auto view = qobject_cast<QAbstractItemView *>(obj)) {
        QItemSelectionModel *sel = view->selectionModel();
        if (!sel || !view->model())
            return {};
        QModelIndexList indexes;
        auto table = qobject_cast<QTableView *>(view);
        if (table && view->selectionBehavior() == QAbstractItemView::SelectRows)
            indexes = sel->selectedRows(0); // a row is one option
        else
            indexes = sel->selectedIndexes();
        std::sort(indexes.begin(), indexes.end(), [](const QModelIndex &a, const QModelIndex &b) {
            // document order: parents before children, then rows, then columns
            QVector<QPair<int, int>> pa, pb;
            for (QModelIndex i = a; i.isValid(); i = i.parent())
                pa.prepend({ i.row(), i.column() });
            for (QModelIndex i = b; i.isValid(); i = i.parent())
                pb.prepend({ i.row(), i.column() });
            return pa < pb;
        });
        QStringList values;
        for (const QModelIndex &index : std::as_const(indexes))
            values.push_back(index.data(Qt::DisplayRole).toString());
        return values;
    }
#endif
    if (obj->inherits("QQuickComboBox"))
        return { obj->property("currentText").toString() };
    *ok = false;
    return {};
}
