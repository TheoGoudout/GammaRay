// SPDX-FileCopyrightText: 2026 Klarälvdalens Datakonsult AB, a KDAB Group company <info@kdab.com>
// SPDX-License-Identifier: GPL-2.0-or-later

#pragma once

#include <QLabel>
#include <QWidget>

class QCheckBox;
class QLineEdit;
class QListWidget;
class QPushButton;
class QSlider;

/*! A label that reports mouse hover, used to test hover(). */
class HoverLabel : public QLabel
{
    Q_OBJECT
public:
    using QLabel::QLabel;

protected:
    void enterEvent(QEnterEvent *event) override;
    void leaveEvent(QEvent *event) override;
};

class WidgetsWindow : public QWidget
{
    Q_OBJECT
    Q_PROPERTY(int loginAttempts READ loginAttempts NOTIFY loginAttemptsChanged)
public:
    explicit WidgetsWindow(QWidget *parent = nullptr);

    int loginAttempts() const
    {
        return m_loginAttempts;
    }

    Q_INVOKABLE void resetForm();
    Q_INVOKABLE int addItems(const QStringList &items);

signals:
    void loggedIn(const QString &user);
    void loginAttemptsChanged();

private:
    void login();
    void updateLoginButton();
    void removeSelected();

    QLineEdit *m_username;
    QLineEdit *m_password;
    QPushButton *m_loginButton;
    QLabel *m_status;
    QCheckBox *m_remember;
    QListWidget *m_items;
    QLineEdit *m_newItem;
    QSlider *m_volume;
    QLabel *m_volumeLabel;
    int m_loginAttempts = 0;
};
