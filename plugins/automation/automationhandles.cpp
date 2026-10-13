/*
  automationhandles.cpp

  This file is part of GammaRay, the Qt application inspection and manipulation tool.

  SPDX-FileCopyrightText: 2026 Klarälvdalens Datakonsult AB, a KDAB Group company <info@kdab.com>

  SPDX-License-Identifier: GPL-2.0-or-later

  Contact KDAB at <info@kdab.com> for commercial licensing options.
*/

#include "automationhandles.h"

using namespace GammaRay::Automation;

qint64 HandleRegistry::handleFor(QObject *obj)
{
    if (!obj)
        return 0;
    const auto it = m_handles.constFind(obj);
    if (it != m_handles.constEnd()) {
        // guard against address reuse after a destruction we did not get notified about
        const QPointer<QObject> &known = m_objects[it.value()];
        if (known == obj)
            return it.value();
        m_objects.remove(it.value());
    }
    const qint64 handle = m_nextHandle++;
    m_objects.insert(handle, QPointer<QObject>(obj));
    m_handles.insert(obj, handle);
    return handle;
}

QObject *HandleRegistry::object(qint64 handle) const
{
    return m_objects.value(handle).data();
}

qint64 HandleRegistry::existingHandle(const QObject *obj) const
{
    return m_handles.value(obj, 0);
}

qint64 HandleRegistry::objectDestroyed(const QObject *obj)
{
    const qint64 handle = m_handles.take(obj);
    if (handle)
        m_objects.remove(handle);
    return handle;
}
