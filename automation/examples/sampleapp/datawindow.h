// SPDX-FileCopyrightText: 2026 Klarälvdalens Datakonsult AB, a KDAB Group company <info@kdab.com>
// SPDX-License-Identifier: GPL-2.0-or-later

#pragma once

#include <QWidget>

class QLabel;

/*! Model/view widgets (tree, table, multi-selection list) and style sheets, shown with --data. */
class DataWindow : public QWidget
{
    Q_OBJECT
public:
    explicit DataWindow(QWidget *parent = nullptr);

private:
    QLabel *m_status = nullptr;
};
