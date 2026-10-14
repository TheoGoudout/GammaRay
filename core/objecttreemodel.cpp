/*
  objecttreemodel.cpp

  This file is part of GammaRay, the Qt application inspection and manipulation tool.

  SPDX-FileCopyrightText: 2010 Klarälvdalens Datakonsult AB, a KDAB Group company <info@kdab.com>
  Author: Volker Krause <volker.krause@kdab.com>

  SPDX-License-Identifier: GPL-2.0-or-later

  Contact KDAB at <info@kdab.com> for commercial licensing options.
*/

#include "objecttreemodel.h"

#include "probe.h"

#include <QEvent>
#include <QMutex>
#include <QThread>
#include <QCoreApplication>

#include <algorithm>
#include <iostream>
#include <utility>

#define IF_DEBUG(x)

extern void dumpObject(QObject *);

using namespace std;
using namespace GammaRay;

ObjectTreeModel::ObjectTreeModel(Probe *probe)
    : ObjectModelBase<QAbstractItemModel>(probe)
{
    connect(probe, &Probe::objectCreated,
            this, &ObjectTreeModel::objectAdded);
    connect(probe, &Probe::objectDestroyed,
            this, &ObjectTreeModel::objectRemoved);
    connect(probe, &Probe::objectReparented,
            this, &ObjectTreeModel::objectReparented);
    connect(probe, &Probe::objectFavorited,
            this, &ObjectTreeModel::objectFavorited);
    connect(probe, &Probe::objectUnfavorited,
            this, &ObjectTreeModel::objectUnfavorited);
}

QPair<int, QVariant> ObjectTreeModel::defaultSelectedItem()
{
    // select the qApp object (if any) in the object model
    return QPair<int, QVariant>(ObjectModel::ObjectRole, QVariant::fromValue<QObject *>(qApp));
}

static inline QObject *parentObject(QObject *obj)
{
    return obj->parent();
}

void ObjectTreeModel::objectAdded(QObject *obj)
{
    // see Probe::objectCreated, that promises a valid object in the main thread here
    Q_ASSERT(thread() == QThread::currentThread());
    Q_ASSERT(Probe::instance()->isValidObject(obj));

    IF_DEBUG(cout << "tree obj added: " << hex << obj << " p: " << parentObject(obj) << endl;)
    Q_ASSERT(!obj->parent() || Probe::instance()->isValidObject(parentObject(obj)));

    if (indexForObject(obj).isValid()) {
        IF_DEBUG(cout << "tree double obj added: " << hex << obj << endl;)
        return;
    }
    m_displayCache.remove(obj); // a new object at the address of a deleted one

    // this is ugly, but apparently it can happen
    // that an object gets created without parent
    // then later the delayed signal comes in
    // so catch this gracefully by first adding the
    // parent if required
    QModelIndex index = indexForObject(parentObject(obj));
    if (parentObject(obj)) {
        if (!index.isValid()) {
            IF_DEBUG(cout << "tree: handle parent first" << endl;)
            objectAdded(parentObject(obj));
            index = indexForObject(parentObject(obj));
        }
    }

    // either we get a proper parent and hence valid index or there is no parent
    Q_ASSERT(index.isValid() || !parentObject(obj));

    QVector<QObject *> &children = m_parentChildMap[parentObject(obj)];
    auto it = std::lower_bound(children.begin(), children.end(), obj);
    const int row = std::distance(children.begin(), it);

    beginInsertRows(index, row, row);

    children.insert(it, obj);
    m_childParentMap.insert(obj, parentObject(obj));

    endInsertRows();
}

void ObjectTreeModel::objectRemoved(QObject *obj)
{
    // slot, hence should always land in main thread due to auto connection
    Q_ASSERT(thread() == QThread::currentThread());

    IF_DEBUG(cout
                 << "tree removed: "
                 << hex << obj << " "
                 << hex << obj->parent() << dec << " "
                 << m_parentChildMap.value(obj->parent()).size() << " "
                 << m_parentChildMap.contains(obj) << endl;)

    auto parentIt = m_childParentMap.constFind(obj);
    if (parentIt == m_childParentMap.cend()) {
        Q_ASSERT(!m_parentChildMap.contains(obj));
        m_displayCache.remove(obj);
        return;
    }

    QObject *parentObj = parentIt.value();
    const QModelIndex parentIndex = indexForObject(parentObj);
    if (parentObj && !parentIndex.isValid()) {
        m_displayCache.remove(obj);
        return;
    }

    QVector<QObject *> &siblings = m_parentChildMap[parentObj];

    auto it = std::lower_bound(siblings.begin(), siblings.end(), obj);
    if (it == siblings.end() || *it != obj) {
        m_displayCache.remove(obj);
        return;
    }
    const int row = std::distance(siblings.begin(), it);

    beginRemoveRows(parentIndex, row, row);

    siblings.erase(it);
    m_childParentMap.erase(parentIt);
    m_parentChildMap.remove(obj);
    m_favorites.remove(obj);

    endRemoveRows();
    m_displayCache.remove(obj);
    m_displayChanged.remove(obj);
}

void ObjectTreeModel::objectReparented(QObject *obj)
{
    // slot, hence should always land in main thread due to auto connection
    Q_ASSERT(thread() == QThread::currentThread());
    IF_DEBUG(cout << "object reparented: " << hex << obj << dec << endl;)

    QMutexLocker objectLock(Probe::objectLock());
    if (!Probe::instance()->isValidObject(obj)) {
        objectRemoved(obj);
        return;
    }

    // we didn't know obj yet
    auto parentIt = m_childParentMap.constFind(obj);
    if (parentIt == m_childParentMap.cend()) {
        Q_ASSERT(!m_parentChildMap.contains(obj));
        objectAdded(obj);
        return;
    }

    QObject *oldParent = parentIt.value();
    const auto sourceParent = indexForObject(oldParent);
    if ((oldParent && !sourceParent.isValid()) || (oldParent == parentObject(obj)))
        return;

    QVector<QObject *> &oldSiblings = m_parentChildMap[oldParent];
    auto oldIt = std::lower_bound(oldSiblings.begin(),
                                  oldSiblings.end(), obj);
    if (oldIt == oldSiblings.end() || *oldIt != obj)
        return;
    const int sourceRow = std::distance(oldSiblings.begin(), oldIt);

    IF_DEBUG(cout << "actually reparenting! " << hex << obj << " old parent: " << oldParent << " new parent: " << parentObject(obj) << dec << endl;)
    const auto destParent = indexForObject(parentObject(obj));
    Q_ASSERT(destParent.isValid() || !parentObject(obj));

    QVector<QObject *> &newSiblings = m_parentChildMap[parentObject(obj)];
    auto newIt = std::lower_bound(newSiblings.begin(),
                                  newSiblings.end(), obj);
    const int destRow = std::distance(newSiblings.begin(), newIt);

    beginMoveRows(sourceParent, sourceRow, sourceRow, destParent, destRow);
    oldSiblings.erase(oldIt);
    newSiblings.insert(newIt, obj);
    m_childParentMap.insert(obj, parentObject(obj));
    endMoveRows();
}

void ObjectTreeModel::objectFavorited(QObject *obj)
{
    auto index = indexForObject(obj);
    if (!index.isValid()) {
        return;
    }
    m_favorites.insert(obj);
    Q_EMIT dataChanged(index, index, { ObjectModel::IsFavoriteRole });
}

void ObjectTreeModel::objectUnfavorited(QObject *obj)
{
    auto index = indexForObject(obj);
    if (!index.isValid()) {
        return;
    }
    Q_ASSERT(m_favorites.contains(obj));
    m_favorites.remove(obj);
    Q_EMIT dataChanged(index, index, { ObjectModel::IsFavoriteRole });
}

QVariant ObjectTreeModel::data(const QModelIndex &index, int role) const
{
    if (!index.isValid())
        return QVariant();

    QObject *obj = reinterpret_cast<QObject *>(index.internalPointer());

    QMutexLocker lock(Probe::objectLock());
    if (role == Qt::DisplayRole && index.column() <= 1)
        return displayData(obj, index);
    if (Probe::instance()->isValidObject(obj)) {
        if (role == ObjectModel::IsFavoriteRole) {
            return m_favorites.contains(obj);
        }
        return dataForObject(obj, index, role);
    }
    if (role == Qt::DisplayRole)
        return tr("<deleted>");

    return QVariant();
}

// pre-condition: the object lock is held
QVariant ObjectTreeModel::displayData(QObject *obj, const QModelIndex &index) const
{
    const bool valid = Probe::instance()->isValidObject(obj);
    QString current;
    if (valid)
        current = dataForObject(obj, index, Qt::DisplayRole).toString();
    else
        current = index.column() == 0 ? Util::addressToString(obj) : tr("<deleted>");

    auto &cachedRow = m_displayCache[obj];
    QString &cached = index.column() == 0 ? cachedRow.first : cachedRow.second;
    if (cached.isNull()) {
        cached = current;
        return cached;
    }
    // a deleted object keeps its last text until its row is removed; anything else that
    // changed is published with a dataChanged() signal, outside of data()
    if (valid && current != cached && !m_displayChanged.contains(obj)) {
        m_displayChanged.insert(obj);
        if (m_displayChanged.size() == 1)
            QMetaObject::invokeMethod(const_cast<ObjectTreeModel *>(this), "flushDisplayChanges", Qt::QueuedConnection);
    }
    return cached;
}

void ObjectTreeModel::flushDisplayChanges()
{
    QVector<QModelIndex> changed;
    {
        QMutexLocker lock(Probe::objectLock());
        const auto objects = std::exchange(m_displayChanged, {});
        for (QObject *obj : objects) {
            const QModelIndex index = indexForObject(obj);
            if (!index.isValid() || !Probe::instance()->isValidObject(obj))
                continue;
            auto &cachedRow = m_displayCache[obj];
            cachedRow.first = dataForObject(obj, index, Qt::DisplayRole).toString();
            cachedRow.second = dataForObject(obj, index.sibling(index.row(), 1), Qt::DisplayRole).toString();
            changed.push_back(index);
        }
    }
    for (const QModelIndex &index : std::as_const(changed))
        emit dataChanged(index, index.sibling(index.row(), 1), { Qt::DisplayRole });
}

int ObjectTreeModel::rowCount(const QModelIndex &parent) const
{
    if (parent.column() == 1)
        return 0;
    QObject *parentObj = reinterpret_cast<QObject *>(parent.internalPointer());
    return m_parentChildMap.value(parentObj).size();
}

QModelIndex ObjectTreeModel::parent(const QModelIndex &child) const
{
    QObject *childObj = reinterpret_cast<QObject *>(child.internalPointer());
    return indexForObject(m_childParentMap.value(childObj));
}

QModelIndex ObjectTreeModel::index(int row, int column, const QModelIndex &parent) const
{
    QObject *parentObj = reinterpret_cast<QObject *>(parent.internalPointer());
    const QVector<QObject *> children = m_parentChildMap.value(parentObj);
    if (row < 0 || column < 0 || row >= children.size() || column >= columnCount())
        return {};
    return createIndex(row, column, children.at(row));
}

QModelIndex ObjectTreeModel::indexForObject(QObject *object) const
{
    if (!object)
        return {};
    // Find the parent
    auto parentIt = m_childParentMap.constFind(object);
    if (parentIt == m_childParentMap.cend())
        return {};

    // Find all children of this parent
    auto childrenIt = m_parentChildMap.constFind(parentIt.value());
    if (childrenIt == m_parentChildMap.cend())
        return {};
    const QVector<QObject *> &siblings = childrenIt.value();

    // Find where @p object is
    auto it = std::lower_bound(siblings.constBegin(), siblings.constEnd(), object);
    if (it == siblings.constEnd() || *it != object)
        return QModelIndex();
    const int row = std::distance(siblings.constBegin(), it);
    return createIndex(row, 0, *it);
}
