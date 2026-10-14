// SPDX-FileCopyrightText: 2026 Klarälvdalens Datakonsult AB, a KDAB Group company <info@kdab.com>
// SPDX-License-Identifier: GPL-2.0-or-later

#include "widgetswindow.h"

#include <QCheckBox>
#include <QComboBox>
#include <QFileDialog>
#include <QMessageBox>
#include <QDialog>
#include <QDialogButtonBox>
#include <QFormLayout>
#include <QGroupBox>
#include <QHBoxLayout>
#include <QLineEdit>
#include <QListWidget>
#include <QPushButton>
#include <QSlider>
#include <QVBoxLayout>

void HoverLabel::enterEvent(QEnterEvent *event)
{
    setText(QStringLiteral("Hovered"));
    QLabel::enterEvent(event);
}

void HoverLabel::leaveEvent(QEvent *event)
{
    setText(QStringLiteral("Not hovered"));
    QLabel::leaveEvent(event);
}

WidgetsWindow::WidgetsWindow(QWidget *parent)
    : QWidget(parent)
{
    setObjectName(QStringLiteral("widgetsWindow"));
    setWindowTitle(QStringLiteral("Widgets Demo"));
    resize(460, 860);

    auto layout = new QVBoxLayout(this);

    // --- login form ---
    auto loginBox = new QGroupBox(QStringLiteral("Login"), this);
    loginBox->setObjectName(QStringLiteral("loginBox"));
    auto form = new QFormLayout(loginBox);
    m_username = new QLineEdit(loginBox);
    m_username->setObjectName(QStringLiteral("username"));
    m_username->setPlaceholderText(QStringLiteral("User name"));
    m_password = new QLineEdit(loginBox);
    m_password->setObjectName(QStringLiteral("password"));
    m_password->setEchoMode(QLineEdit::Password);
    m_remember = new QCheckBox(QStringLiteral("Remember me"), loginBox);
    m_remember->setObjectName(QStringLiteral("rememberMe"));
    m_loginButton = new QPushButton(QStringLiteral("&Login"), loginBox);
    m_loginButton->setObjectName(QStringLiteral("loginButton"));
    m_loginButton->setToolTip(QStringLiteral("Log in with your account"));
    m_status = new QLabel(QStringLiteral("Please log in"), loginBox);
    m_status->setObjectName(QStringLiteral("statusLabel"));
    form->addRow(QStringLiteral("User:"), m_username);
    form->addRow(QStringLiteral("Password:"), m_password);
    form->addRow(m_remember);
    form->addRow(m_loginButton);
    form->addRow(m_status);
    layout->addWidget(loginBox);

    connect(m_username, &QLineEdit::textChanged, this, &WidgetsWindow::updateLoginButton);
    connect(m_password, &QLineEdit::textChanged, this, &WidgetsWindow::updateLoginButton);
    connect(m_loginButton, &QPushButton::clicked, this, &WidgetsWindow::login);
    connect(m_password, &QLineEdit::returnPressed, this, &WidgetsWindow::login);
    updateLoginButton();

    // --- list ---
    auto listBox = new QGroupBox(QStringLiteral("Items"), this);
    listBox->setObjectName(QStringLiteral("listBox"));
    auto listLayout = new QVBoxLayout(listBox);
    m_items = new QListWidget(listBox);
    m_items->setObjectName(QStringLiteral("itemList"));
    m_items->addItems({ QStringLiteral("Apple"), QStringLiteral("Banana"), QStringLiteral("Cherry") });
    listLayout->addWidget(m_items);
    auto addRow = new QHBoxLayout;
    m_newItem = new QLineEdit(listBox);
    m_newItem->setObjectName(QStringLiteral("newItem"));
    auto addButton = new QPushButton(QStringLiteral("Add"), listBox);
    addButton->setObjectName(QStringLiteral("addButton"));
    auto removeButton = new QPushButton(QStringLiteral("Remove"), listBox);
    removeButton->setObjectName(QStringLiteral("removeButton"));
    addRow->addWidget(m_newItem);
    addRow->addWidget(addButton);
    addRow->addWidget(removeButton);
    listLayout->addLayout(addRow);
    layout->addWidget(listBox);

    connect(addButton, &QPushButton::clicked, this, [this]() {
        if (!m_newItem->text().isEmpty()) {
            m_items->addItem(m_newItem->text());
            m_newItem->clear();
        }
    });
    connect(removeButton, &QPushButton::clicked, this, &WidgetsWindow::removeSelected);
    connect(m_items, &QListWidget::itemDoubleClicked, this, [this](QListWidgetItem *item) {
        m_status->setText(QStringLiteral("Opened: %1").arg(item->text()));
    });

    // --- misc: slider, hover, long list ---
    m_volume = new QSlider(Qt::Horizontal, this);
    m_volume->setObjectName(QStringLiteral("volumeSlider"));
    m_volume->setRange(0, 100);
    m_volumeLabel = new QLabel(QStringLiteral("Volume: 0"), this);
    m_volumeLabel->setObjectName(QStringLiteral("volumeLabel"));
    connect(m_volume, &QSlider::valueChanged, this, [this](int v) {
        m_volumeLabel->setText(QStringLiteral("Volume: %1").arg(v));
    });
    layout->addWidget(m_volume);
    layout->addWidget(m_volumeLabel);

    // --- combo box, file dialog, message box, read-only field ---
    auto extras = new QFormLayout;
    auto color = new QComboBox(this);
    color->setObjectName(QStringLiteral("colorCombo"));
    color->addItem(QStringLiteral("Red"), QStringLiteral("r"));
    color->addItem(QStringLiteral("Green"), QStringLiteral("g"));
    color->addItem(QStringLiteral("Blue"), QStringLiteral("b"));
    auto colorLabel = new QLabel(QStringLiteral("No color chosen"), this);
    colorLabel->setObjectName(QStringLiteral("colorLabel"));
    // only reacts to the user picking an item (activated), not to programmatic changes
    connect(color, &QComboBox::activated, this, [color, colorLabel](int index) {
        colorLabel->setText(QStringLiteral("Color: %1 (%2)").arg(color->itemText(index), color->itemData(index).toString()));
    });
    extras->addRow(QStringLiteral("Color:"), color);
    extras->addRow(colorLabel);

    auto fileButton = new QPushButton(QStringLiteral("Choose file..."), this);
    fileButton->setObjectName(QStringLiteral("fileButton"));
    auto fileLabel = new QLabel(QStringLiteral("No file"), this);
    fileLabel->setObjectName(QStringLiteral("fileLabel"));
    connect(fileButton, &QPushButton::clicked, this, [this, fileLabel]() {
        const QString file = QFileDialog::getOpenFileName(this, QStringLiteral("Choose a file"), QString(), QString(), nullptr,
                                                          QFileDialog::DontUseNativeDialog);
        fileLabel->setText(file.isEmpty() ? QStringLiteral("No file") : QStringLiteral("File: %1").arg(file));
    });
    auto resetButton = new QPushButton(QStringLiteral("Reset..."), this);
    resetButton->setObjectName(QStringLiteral("resetButton"));
    connect(resetButton, &QPushButton::clicked, this, [this]() {
        if (QMessageBox::question(this, QStringLiteral("Reset"), QStringLiteral("Reset the login form?")) == QMessageBox::Yes) {
            resetForm();
            m_status->setText(QStringLiteral("Form reset"));
        } else {
            m_status->setText(QStringLiteral("Reset cancelled"));
        }
    });
    auto buttons = new QHBoxLayout;
    buttons->addWidget(fileButton);
    buttons->addWidget(resetButton);
    extras->addRow(buttons);
    extras->addRow(fileLabel);
    auto serial = new QLineEdit(QStringLiteral("QTPW-0001"), this);
    serial->setObjectName(QStringLiteral("serialField"));
    serial->setReadOnly(true);
    extras->addRow(QStringLiteral("Serial:"), serial);
    layout->addLayout(extras);

    auto hover = new HoverLabel(QStringLiteral("Not hovered"), this);
    hover->setObjectName(QStringLiteral("hoverLabel"));
    hover->setFrameShape(QFrame::Box);
    hover->setMinimumHeight(30);
    layout->addWidget(hover);

    auto longList = new QListWidget(this);
    longList->setObjectName(QStringLiteral("longList"));
    for (int i = 0; i < 100; ++i)
        longList->addItem(QStringLiteral("Row %1").arg(i));
    longList->setFixedHeight(120);
    layout->addWidget(longList);
}

void WidgetsWindow::updateLoginButton()
{
    m_loginButton->setEnabled(!m_username->text().isEmpty() && !m_password->text().isEmpty());
}

void WidgetsWindow::login()
{
    ++m_loginAttempts;
    emit loginAttemptsChanged();
    if (m_username->text() == QLatin1String("admin") && m_password->text() == QLatin1String("secret")) {
        m_status->setText(QStringLiteral("Welcome, %1!").arg(m_username->text()));
        emit loggedIn(m_username->text());
    } else {
        m_status->setText(QStringLiteral("Invalid credentials"));
    }
}

void WidgetsWindow::removeSelected()
{
    QListWidgetItem *item = m_items->currentItem();
    if (!item)
        return;

    QDialog dialog(this);
    dialog.setObjectName(QStringLiteral("confirmDialog"));
    dialog.setWindowTitle(QStringLiteral("Confirm"));
    auto layout = new QVBoxLayout(&dialog);
    auto label = new QLabel(QStringLiteral("Remove '%1'?").arg(item->text()), &dialog);
    label->setObjectName(QStringLiteral("confirmText"));
    layout->addWidget(label);
    auto buttons = new QDialogButtonBox(QDialogButtonBox::Ok | QDialogButtonBox::Cancel, &dialog);
    layout->addWidget(buttons);
    connect(buttons, &QDialogButtonBox::accepted, &dialog, &QDialog::accept);
    connect(buttons, &QDialogButtonBox::rejected, &dialog, &QDialog::reject);

    if (dialog.exec() == QDialog::Accepted) // modal: nested event loop
        delete m_items->takeItem(m_items->row(item));
}

void WidgetsWindow::resetForm()
{
    m_username->clear();
    m_password->clear();
    m_remember->setChecked(false);
    m_status->setText(QStringLiteral("Please log in"));
}

int WidgetsWindow::addItems(const QStringList &items)
{
    m_items->addItems(items);
    return m_items->count();
}
