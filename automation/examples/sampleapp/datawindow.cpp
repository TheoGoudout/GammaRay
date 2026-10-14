// SPDX-FileCopyrightText: 2026 Klarälvdalens Datakonsult AB, a KDAB Group company <info@kdab.com>
// SPDX-License-Identifier: GPL-2.0-or-later

#include "datawindow.h"

#include <QFormLayout>
#include <QGroupBox>
#include <QHeaderView>
#include <QLabel>
#include <QListWidget>
#include <QTableWidget>
#include <QTreeWidget>
#include <QVBoxLayout>

DataWindow::DataWindow(QWidget *parent)
    : QWidget(parent)
{
    setObjectName(QStringLiteral("dataWindow"));
    setWindowTitle(QStringLiteral("Data Demo"));
    resize(420, 760);
    auto layout = new QVBoxLayout(this);

    // a tree with collapsed branches and checkable leaves
    auto tree = new QTreeWidget(this);
    tree->setObjectName(QStringLiteral("fileTree"));
    tree->setHeaderLabels({ QStringLiteral("Name"), QStringLiteral("Size") });
    tree->setFixedHeight(170);
    const QList<QPair<QString, QStringList>> folders {
        { QStringLiteral("Documents"), { QStringLiteral("report.pdf"), QStringLiteral("notes.txt") } },
        { QStringLiteral("Pictures"), { QStringLiteral("cat.png"), QStringLiteral("dog.png"), QStringLiteral("bird.png") } },
        { QStringLiteral("Music"), {} },
    };
    for (const auto &folder : folders) {
        auto item = new QTreeWidgetItem(tree, { folder.first, QString() });
        for (const QString &file : folder.second) {
            auto child = new QTreeWidgetItem(item, { file, QStringLiteral("%1 KB").arg(file.size() * 3) });
            child->setFlags(child->flags() | Qt::ItemIsUserCheckable);
            child->setCheckState(0, Qt::Unchecked);
        }
    }
    layout->addWidget(tree);

    // a table with headers; rows are selected as a whole
    auto table = new QTableWidget(4, 3, this);
    table->setObjectName(QStringLiteral("peopleTable"));
    table->setHorizontalHeaderLabels({ QStringLiteral("Name"), QStringLiteral("Age"), QStringLiteral("City") });
    table->setSelectionBehavior(QAbstractItemView::SelectRows);
    table->setFixedHeight(160);
    const QStringList people[] = {
        { QStringLiteral("Alice"), QStringLiteral("34"), QStringLiteral("Berlin") },
        { QStringLiteral("Bob"), QStringLiteral("27"), QStringLiteral("Paris") },
        { QStringLiteral("Carol"), QStringLiteral("45"), QStringLiteral("Oslo") },
        { QStringLiteral("Dave"), QStringLiteral("52"), QStringLiteral("Rome") },
    };
    for (int r = 0; r < 4; ++r) {
        for (int c = 0; c < 3; ++c)
            table->setItem(r, c, new QTableWidgetItem(people[r][c]));
    }
    table->horizontalHeader()->setStretchLastSection(true);
    layout->addWidget(table);

    // a multi-selection list with check boxes
    auto tags = new QListWidget(this);
    tags->setObjectName(QStringLiteral("tagList"));
    tags->setSelectionMode(QAbstractItemView::ExtendedSelection);
    tags->setFixedHeight(130);
    for (const char *tag : { "red", "green", "blue", "yellow", "purple" }) {
        auto item = new QListWidgetItem(QString::fromLatin1(tag), tags);
        item->setFlags(item->flags() | Qt::ItemIsUserCheckable);
        item->setCheckState(Qt::Unchecked);
        item->setToolTip(QStringLiteral("The color %1").arg(QString::fromLatin1(tag)));
    }
    layout->addWidget(tags);

    m_status = new QLabel(QStringLiteral("Nothing activated"), this);
    m_status->setObjectName(QStringLiteral("dataStatus"));
    layout->addWidget(m_status);

    // style sheets and palettes, for toHaveCSS()
    auto styled = new QLabel(QStringLiteral("Warning!"), this);
    styled->setObjectName(QStringLiteral("warningLabel"));
    styled->setStyleSheet(QStringLiteral("color: #c00000; background-color: rgb(255, 240, 200); font-size: 18px; font-weight: bold;"));
    layout->addWidget(styled);
    auto hint = new QLabel(QStringLiteral("Just a hint"), this);
    hint->setObjectName(QStringLiteral("hintLabel"));
    QPalette pal = hint->palette();
    pal.setColor(QPalette::WindowText, QColor(0, 0, 255));
    hint->setPalette(pal);
    QFont font = hint->font();
    font.setItalic(true);
    hint->setFont(font);
    layout->addWidget(hint);
    layout->addStretch();

    connect(tree, &QTreeWidget::itemDoubleClicked, this, [this](QTreeWidgetItem *item) {
        m_status->setText(QStringLiteral("Opened %1").arg(item->text(0)));
    });
    connect(tree, &QTreeWidget::itemChanged, this, [this](QTreeWidgetItem *item) {
        m_status->setText(QStringLiteral("%1 %2").arg(item->text(0), item->checkState(0) == Qt::Checked ? QStringLiteral("checked") : QStringLiteral("unchecked")));
    });
    connect(table, &QTableWidget::itemSelectionChanged, this, [this, table]() {
        const auto rows = table->selectionModel()->selectedRows();
        m_status->setText(rows.isEmpty() ? QStringLiteral("No row selected")
                                         : QStringLiteral("Selected %1").arg(table->item(rows.first().row(), 0)->text()));
    });
    connect(tags, &QListWidget::itemSelectionChanged, this, [this, tags]() {
        QStringList names;
        for (QListWidgetItem *item : tags->selectedItems())
            names.push_back(item->text());
        names.sort();
        m_status->setText(QStringLiteral("Tags: %1").arg(names.join(QStringLiteral(", "))));
    });
}
