/*
  automationitemview.h

  This file is part of GammaRay, the Qt application inspection and manipulation tool.

  SPDX-FileCopyrightText: 2026 Klarälvdalens Datakonsult AB, a KDAB Group company <info@kdab.com>

  SPDX-License-Identifier: GPL-2.0-or-later

  Contact KDAB at <info@kdab.com> for commercial licensing options.
*/

#ifndef GAMMARAY_AUTOMATIONITEMVIEW_H
#define GAMMARAY_AUTOMATIONITEMVIEW_H

#include <QAbstractItemView>
#include <QObject>
#include <QPersistentModelIndex>
#include <QPointer>
#include <QRect>
#include <QStringList>
#include <QVector>

namespace GammaRay {
namespace Automation {

/*!
 * A model/view row (or table cell) as an element.
 *
 * Item views paint their rows; there are no QObjects for them. ViewItem is a
 * lightweight stand-in so rows can be located, clicked, checked and asserted like
 * any other element: list rows become "listitem"s, tree rows "treeitem"s (children
 * of their parent row while it is expanded), table rows "row"s with "cell" children.
 *
 * ViewItems are owned by the automation plugin (never by the view, so the
 * application's object tree is unaffected) and are deleted once their model
 * index becomes invalid.
 */
class ViewItem : public QObject
{
    Q_OBJECT
    Q_PROPERTY(QString text READ text)
    Q_PROPERTY(int row READ row)
    Q_PROPERTY(int column READ column)
    Q_PROPERTY(bool selected READ isSelected WRITE setSelected)
    Q_PROPERTY(bool current READ isCurrent)
    Q_PROPERTY(bool checkable READ isCheckable)
    Q_PROPERTY(bool checked READ isChecked WRITE setChecked)
    Q_PROPERTY(bool expanded READ isExpanded WRITE setExpanded)
    Q_PROPERTY(bool editable READ isEditable)
    Q_PROPERTY(QString toolTip READ toolTip)
    Q_PROPERTY(QStringList cells READ cells)
    Q_PROPERTY(Kind kind READ kind)

public:
    enum Kind
    {
        ListItem,
        TreeItem,
        TableRow,
        TableCell
    };
    Q_ENUM(Kind)

    ViewItem(QAbstractItemView *view, const QModelIndex &index, Kind kind, QObject *parent);

    QAbstractItemView *view() const
    {
        return m_view;
    }
    QModelIndex index() const
    {
        return m_index;
    }
    Kind kind() const
    {
        return m_kind;
    }
    bool isValid() const
    {
        return m_view && m_index.isValid();
    }

    QString text() const;
    int row() const;
    int column() const;
    bool isSelected() const;
    void setSelected(bool selected);
    bool isCurrent() const;
    bool isCheckable() const;
    bool isChecked() const;
    void setChecked(bool checked);
    bool isExpanded() const;
    void setExpanded(bool expanded);
    bool isEditable() const;
    bool isEnabled() const;
    QString toolTip() const;
    /*! Display texts of the visible cells of the row (all kinds). */
    QStringList cells() const;

    /*! ARIA role: listitem, treeitem, row or cell. */
    QString role() const;
    /*! Depth in a tree (1 for top-level rows), 0 otherwise. */
    int level() const;

    /*! Rectangle in viewport coordinates (may be outside the viewport when scrolled away). */
    QRect viewportRect() const;
    /*! Whether the row is shown at all (not a hidden row/column, ancestors expanded). */
    bool isShown() const;
    /*! Where to click to toggle the check box, in local coordinates. */
    QPointF checkIndicatorPosition() const;

private:
    QPointer<QAbstractItemView> m_view;
    QPersistentModelIndex m_index;
    Kind m_kind;
};

namespace ViewItems {
/*! The row elements directly below @p obj (an item view or a ViewItem), in row order. */
QVector<QObject *> children(QObject *obj);
/*! The ViewItem (or the view) a ViewItem belongs to. */
QObject *parent(ViewItem *item);
/*! The row element at @p viewportPos of @p view (the cell for tables), or nullptr. */
ViewItem *itemAt(QAbstractItemView *view, QPoint viewportPos);
/*! The view whose viewport is @p widget, if any. */
QAbstractItemView *viewForViewport(QWidget *widget);
}

}
}

#endif
