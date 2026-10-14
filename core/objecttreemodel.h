/*
  objecttreemodel.h

  This file is part of GammaRay, the Qt application inspection and manipulation tool.

  SPDX-FileCopyrightText: 2010 Klarälvdalens Datakonsult AB, a KDAB Group company <info@kdab.com>
  Author: Volker Krause <volker.krause@kdab.com>

  SPDX-License-Identifier: GPL-2.0-or-later

  Contact KDAB at <info@kdab.com> for commercial licensing options.
*/

#ifndef GAMMARAY_OBJECTTREEMODEL_H
#define GAMMARAY_OBJECTTREEMODEL_H

#include "objectmodelbase.h"

#include <QSet>
#include <QVector>

namespace GammaRay {
class Probe;

class ObjectTreeModel : public ObjectModelBase<QAbstractItemModel>
{
    Q_OBJECT
public:
    explicit ObjectTreeModel(Probe *probe);

    QVariant data(const QModelIndex &index, int role = Qt::DisplayRole) const override;
    int rowCount(const QModelIndex &parent = QModelIndex()) const override;
    QModelIndex parent(const QModelIndex &child) const override;
    QModelIndex index(int row, int column,
                      const QModelIndex &parent = QModelIndex()) const override;

    Q_INVOKABLE static QPair<int, QVariant> defaultSelectedItem();

private slots:
    void objectAdded(QObject *obj);
    void objectRemoved(QObject *obj);
    void objectReparented(QObject *obj);
    void objectFavorited(QObject *obj);
    void objectUnfavorited(QObject *obj);

private:
    QModelIndex indexForObject(QObject *object) const;

private:
    QHash<QObject *, QObject *> m_childParentMap;
    QHash<QObject *, QVector<QObject *>> m_parentChildMap;
    QSet<QObject *> m_favorites;
    QVariant displayData(QObject *obj, const QModelIndex &index) const;
    Q_INVOKABLE void flushDisplayChanges();

    // Display texts (columns 0 and 1) as last reported for each row. A (recursive) filter
    // proxy on top of this model must see the same text for a row until dataChanged() is
    // emitted for it, or its mapping gets corrupted. Without the cache that happens when an
    // object is deleted in another thread (its row stays until the queued objectRemoved()
    // runs), when its address is reused by a new object in the meantime, or when it is
    // renamed. Changed texts are therefore only published together with dataChanged().
    mutable QHash<QObject *, QPair<QString, QString>> m_displayCache;
    mutable QSet<QObject *> m_displayChanged;
};
}

#endif // GAMMARAY_OBJECTTREEMODEL_H
