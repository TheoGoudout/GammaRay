/*
  automationitemview.cpp

  This file is part of GammaRay, the Qt application inspection and manipulation tool.

  SPDX-FileCopyrightText: 2026 Klarälvdalens Datakonsult AB, a KDAB Group company <info@kdab.com>

  SPDX-License-Identifier: GPL-2.0-or-later

  Contact KDAB at <info@kdab.com> for commercial licensing options.
*/

#include "automationitemview.h"

#include <core/probeguard.h>

#include <QAbstractItemView>
#include <QApplication>
#include <QHash>
#include <QHeaderView>
#include <QItemSelectionModel>
#include <QListView>
#include <QStyle>
#include <QStyleOptionViewItem>
#include <QTableView>
#include <QTreeView>

using namespace GammaRay;
using namespace GammaRay::Automation;

// rows exposed per parent; huge models are only reachable through their first rows
static const int MaxRowsPerParent = 5000;

ViewItem::ViewItem(QAbstractItemView *view, const QModelIndex &index, Kind kind, QObject *parent)
    : QObject(parent)
    , m_view(view)
    , m_index(index)
    , m_kind(kind)
{
}

static QString displayText(const QModelIndex &index)
{
    return index.data(Qt::DisplayRole).toString();
}

static QVector<int> visibleColumns(QAbstractItemView *view, const QModelIndex &parent)
{
    QVector<int> columns;
    const int count = view->model()->columnCount(parent);
    auto table = qobject_cast<QTableView *>(view);
    auto tree = qobject_cast<QTreeView *>(view);
    for (int c = 0; c < count; ++c) {
        if ((table && table->isColumnHidden(c)) || (tree && tree->isColumnHidden(c)))
            continue;
        columns.push_back(c);
    }
    return columns;
}

QStringList ViewItem::cells() const
{
    QStringList result;
    if (!isValid())
        return result;
    if (m_kind == TableCell || m_kind == ListItem)
        return { displayText(m_index) };
    const QModelIndex parent = m_index.parent();
    const auto columns = visibleColumns(m_view, parent);
    for (int c : columns)
        result.push_back(displayText(m_view->model()->index(m_index.row(), c, parent)));
    return result;
}

QString ViewItem::text() const
{
    if (!isValid())
        return QString();
    if (m_kind == TableRow)
        return cells().join(QLatin1Char(' ')); // like the accessible name of a table row
    return displayText(m_index);
}

int ViewItem::row() const
{
    return m_index.row();
}

int ViewItem::column() const
{
    return m_index.column();
}

bool ViewItem::isSelected() const
{
    if (!isValid() || !m_view->selectionModel())
        return false;
    if (m_kind == TableRow)
        return m_view->selectionModel()->isRowSelected(m_index.row(), m_index.parent());
    return m_view->selectionModel()->isSelected(m_index);
}

void ViewItem::setSelected(bool selected)
{
    if (!isValid() || !m_view->selectionModel())
        return;
    QItemSelectionModel::SelectionFlags flags = selected ? QItemSelectionModel::Select : QItemSelectionModel::Deselect;
    if (m_kind == TableRow || m_kind == TreeItem)
        flags |= QItemSelectionModel::Rows;
    m_view->selectionModel()->select(m_index, flags);
}

bool ViewItem::isCurrent() const
{
    if (!isValid())
        return false;
    const QModelIndex current = m_view->currentIndex();
    if (m_kind == TableRow)
        return current.row() == m_index.row() && current.parent() == m_index.parent();
    return current == m_index;
}

bool ViewItem::isCheckable() const
{
    if (!isValid())
        return false;
    return (m_index.flags() & Qt::ItemIsUserCheckable) || m_index.data(Qt::CheckStateRole).isValid();
}

bool ViewItem::isChecked() const
{
    return isValid() && m_index.data(Qt::CheckStateRole).toInt() == Qt::Checked;
}

void ViewItem::setChecked(bool checked)
{
    if (isValid())
        m_view->model()->setData(m_index, checked ? Qt::Checked : Qt::Unchecked, Qt::CheckStateRole);
}

bool ViewItem::isExpanded() const
{
    auto tree = qobject_cast<QTreeView *>(m_view.data());
    return tree && m_index.isValid() && tree->isExpanded(m_index);
}

void ViewItem::setExpanded(bool expanded)
{
    if (auto tree = qobject_cast<QTreeView *>(m_view.data()); tree && m_index.isValid())
        tree->setExpanded(m_index, expanded);
}

bool ViewItem::isEditable() const
{
    return isValid() && (m_index.flags() & Qt::ItemIsEditable) && m_view->editTriggers() != QAbstractItemView::NoEditTriggers;
}

bool ViewItem::isEnabled() const
{
    return isValid() && m_view->isEnabled() && (m_index.flags() & Qt::ItemIsEnabled);
}

QString ViewItem::toolTip() const
{
    return isValid() ? m_index.data(Qt::ToolTipRole).toString() : QString();
}

QString ViewItem::role() const
{
    switch (m_kind) {
    case ListItem:
        return QStringLiteral("listitem");
    case TreeItem:
        return QStringLiteral("treeitem");
    case TableRow:
        return QStringLiteral("row");
    case TableCell:
        return QStringLiteral("cell");
    }
    return QString();
}

int ViewItem::level() const
{
    if (m_kind != TreeItem || !m_index.isValid())
        return 0;
    int level = 0;
    const QModelIndex root = m_view ? m_view->rootIndex() : QModelIndex();
    for (QModelIndex i = m_index; i.isValid() && i != root; i = i.parent())
        ++level;
    return level;
}

QRect ViewItem::viewportRect() const
{
    if (!isValid())
        return QRect();
    if (m_kind != TableRow)
        return m_view->visualRect(m_index);
    QRect r;
    const auto columns = visibleColumns(m_view, m_index.parent());
    for (int c : columns)
        r |= m_view->visualRect(m_view->model()->index(m_index.row(), c, m_index.parent()));
    return r;
}

bool ViewItem::isShown() const
{
    if (!isValid() || !m_view->isVisible())
        return false;
    if (auto table = qobject_cast<QTableView *>(m_view.data())) {
        if (table->isRowHidden(m_index.row()))
            return false;
        if (m_kind == TableCell && table->isColumnHidden(m_index.column()))
            return false;
    } else if (auto tree = qobject_cast<QTreeView *>(m_view.data())) {
        const QModelIndex root = tree->rootIndex();
        for (QModelIndex i = m_index; i.isValid() && i != root; i = i.parent()) {
            if (tree->isRowHidden(i.row(), i.parent()))
                return false;
            if (i != m_index && !tree->isExpanded(i))
                return false;
        }
    } else if (auto list = qobject_cast<QListView *>(m_view.data())) {
        if (list->isRowHidden(m_index.row()))
            return false;
    }
    return !viewportRect().isEmpty();
}

QPointF ViewItem::checkIndicatorPosition() const
{
    const QRect r = viewportRect();
    if (!isValid() || !isCheckable())
        return QPointF(r.width() / 2.0, r.height() / 2.0);
    QStyleOptionViewItem opt;
    opt.initFrom(m_view->viewport());
    opt.rect = r;
    opt.features = QStyleOptionViewItem::HasCheckIndicator | QStyleOptionViewItem::HasDisplay;
    opt.text = displayText(m_index);
    opt.checkState = static_cast<Qt::CheckState>(m_index.data(Qt::CheckStateRole).toInt());
    if (m_index.data(Qt::DecorationRole).isValid())
        opt.features |= QStyleOptionViewItem::HasDecoration;
    opt.decorationSize = m_view->iconSize().isValid() ? m_view->iconSize() : QSize(16, 16);
    QStyle *style = m_view->style();
    const QRect check = style->subElementRect(QStyle::SE_ItemViewItemCheckIndicator, &opt, m_view);
    if (!check.isValid())
        return QPointF(r.width() / 2.0, r.height() / 2.0);
    return QPointF(check.center() - r.topLeft()) + QPointF(0.5, 0.5);
}

namespace {
struct ViewData
{
    QHash<QPersistentModelIndex, ViewItem *> items[4]; // per ViewItem::Kind
};

class Registry : public QObject
{
public:
    QHash<QAbstractItemView *, ViewData> views;

    ViewItem *item(QAbstractItemView *view, const QModelIndex &index, ViewItem::Kind kind)
    {
        auto data = views.find(view);
        if (data == views.end()) {
            // first time we see this view: drop its items once it goes away
            data = views.insert(view, ViewData());
            connect(view, &QObject::destroyed, this, [this, view]() { drop(view); });
        }
        auto &items = data->items[kind];
        const QPersistentModelIndex key(index);
        auto it = items.find(key);
        if (it != items.end()) {
            if (it.value()->isValid())
                return it.value();
            delete it.value();
            items.erase(it);
        }
        ProbeGuard guard; // not an application object
        auto item = new ViewItem(view, index, kind, this);
        items.insert(key, item);
        return item;
    }

    void prune(QAbstractItemView *view)
    {
        auto it = views.find(view);
        if (it == views.end())
            return;
        for (auto &items : it->items) {
            for (auto i = items.begin(); i != items.end();) {
                if (!i.value()->isValid() || !i.key().isValid()) {
                    delete i.value();
                    i = items.erase(i);
                } else {
                    ++i;
                }
            }
        }
    }

    void drop(QAbstractItemView *view)
    {
        auto it = views.find(view);
        if (it == views.end())
            return;
        for (auto &items : it->items)
            qDeleteAll(items);
        views.erase(it);
    }
};

Registry *registry()
{
    static QPointer<Registry> s_registry;
    if (!s_registry) {
        ProbeGuard guard;
        s_registry = new Registry;
        s_registry->setParent(QCoreApplication::instance());
    }
    return s_registry;
}

ViewItem::Kind rowKind(QAbstractItemView *view)
{
    if (qobject_cast<QTableView *>(view))
        return ViewItem::TableRow;
    if (qobject_cast<QTreeView *>(view))
        return ViewItem::TreeItem;
    return ViewItem::ListItem;
}

int displayColumn(QAbstractItemView *view)
{
    if (auto list = qobject_cast<QListView *>(view))
        return list->modelColumn();
    if (auto tree = qobject_cast<QTreeView *>(view)) {
        // the first visible column carries the tree decoration
        if (tree->header())
            return qMax(0, tree->header()->logicalIndex(0));
    }
    return 0;
}

QVector<QObject *> rowsBelow(QAbstractItemView *view, const QModelIndex &parent)
{
    QVector<QObject *> result;
    QAbstractItemModel *model = view->model();
    if (!model)
        return result;
    const ViewItem::Kind kind = rowKind(view);
    const int column = kind == ViewItem::TableRow ? 0 : displayColumn(view);
    if (column >= model->columnCount(parent))
        return result;
    const int rows = qMin(model->rowCount(parent), MaxRowsPerParent);
    result.reserve(rows);
    for (int r = 0; r < rows; ++r)
        result.push_back(registry()->item(view, model->index(r, column, parent), kind));
    return result;
}
}

QVector<QObject *> ViewItems::children(QObject *obj)
{
    if (auto view = qobject_cast<QAbstractItemView *>(obj)) {
        if (!view->model() || qobject_cast<QHeaderView *>(view))
            return {};
        registry()->prune(view);
        return rowsBelow(view, view->rootIndex());
    }
    auto item = qobject_cast<ViewItem *>(obj);
    if (!item || !item->isValid())
        return {};
    QAbstractItemView *view = item->view();
    switch (item->kind()) {
    case ViewItem::TreeItem: {
        auto tree = static_cast<QTreeView *>(view);
        if (!tree->isExpanded(item->index()))
            return {};
        return rowsBelow(view, item->index());
    }
    case ViewItem::TableRow: {
        QVector<QObject *> cells;
        const QModelIndex parent = item->index().parent();
        const auto columns = visibleColumns(view, parent);
        for (int c : columns)
            cells.push_back(registry()->item(view, view->model()->index(item->row(), c, parent), ViewItem::TableCell));
        return cells;
    }
    default:
        return {};
    }
}

QObject *ViewItems::parent(ViewItem *item)
{
    if (!item->isValid())
        return nullptr;
    QAbstractItemView *view = item->view();
    switch (item->kind()) {
    case ViewItem::TreeItem: {
        const QModelIndex parent = item->index().parent();
        if (parent.isValid() && parent != view->rootIndex())
            return registry()->item(view, parent.siblingAtColumn(item->index().column()), ViewItem::TreeItem);
        return view;
    }
    case ViewItem::TableCell:
        return registry()->item(view, item->index().siblingAtColumn(0), ViewItem::TableRow);
    default:
        return view;
    }
}

ViewItem *ViewItems::itemAt(QAbstractItemView *view, QPoint viewportPos)
{
    if (!view->model())
        return nullptr;
    const QModelIndex index = view->indexAt(viewportPos);
    if (!index.isValid())
        return nullptr;
    switch (rowKind(view)) {
    case ViewItem::TableRow:
        return registry()->item(view, index, ViewItem::TableCell);
    case ViewItem::TreeItem:
        return registry()->item(view, index.siblingAtColumn(displayColumn(view)), ViewItem::TreeItem);
    default:
        return registry()->item(view, index, ViewItem::ListItem);
    }
}

QAbstractItemView *ViewItems::viewForViewport(QWidget *widget)
{
    if (!widget)
        return nullptr;
    auto view = qobject_cast<QAbstractItemView *>(widget->parentWidget());
    if (view && view->viewport() == widget)
        return view;
    return nullptr;
}
