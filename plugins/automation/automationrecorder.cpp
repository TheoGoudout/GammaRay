/*
  automationrecorder.cpp

  This file is part of GammaRay, the Qt application inspection and manipulation tool.

  SPDX-FileCopyrightText: 2026 Klarälvdalens Datakonsult AB, a KDAB Group company <info@kdab.com>

  SPDX-License-Identifier: GPL-2.0-or-later

  Contact KDAB at <info@kdab.com> for commercial licensing options.
*/

#include "automationrecorder.h"
#include "automationelement.h"
#include "automationinput.h"

#include <QBuffer>
#include <QGuiApplication>
#include <QImageWriter>
#include <QPainter>
#include <QPainterPath>
#include <QWindow>
#include <QtEndian>

#ifdef QT_WIDGETS_LIB
#include <QWidget>
#endif

#include <algorithm>
#include <cmath>

using namespace GammaRay;
using namespace GammaRay::Automation;

static const qreal TitleBarHeight = 22;

namespace {
// Stacking order heuristic (the offscreen platform has no real window stacking):
// normal windows, then the active one, then dialogs, then popups/tool tips.
int stackingRank(QObject *window)
{
    Qt::WindowType type = Qt::Window;
    QWindow *handle = nullptr;
#ifdef QT_WIDGETS_LIB
    if (auto w = qobject_cast<QWidget *>(window)) {
        type = w->windowType();
        handle = w->windowHandle();
    }
#endif
    if (auto w = qobject_cast<QWindow *>(window)) {
        type = w->type();
        handle = w;
    }
    if (type == Qt::Popup || type == Qt::ToolTip)
        return 3;
    if (type == Qt::Dialog || type == Qt::Sheet || (handle && handle->transientParent()))
        return 2;
    if (handle && handle == QGuiApplication::focusWindow())
        return 1;
    return 0;
}

QVector<QObject *> windowsInStackingOrder()
{
    auto windows = Element::topLevelWindows(true);
    std::stable_sort(windows.begin(), windows.end(),
                     [](QObject *a, QObject *b) { return stackingRank(a) < stackingRank(b); });
    return windows;
}

int even(qreal v)
{
    return std::max(2, int(std::ceil(v / 2.0)) * 2);
}
}

Recorder::Recorder(quint32 id, const Options &options, FrameSink sink, QObject *parent)
    : QObject(parent)
    , m_id(id)
    , m_options(options)
    , m_sink(std::move(sink))
{
    m_options.fps = qBound(1, m_options.fps, 60);
    m_options.scale = qBound(0.05, m_options.scale, 4.0);
    m_options.quality = qBound(1, m_options.quality, 100);
    m_format = QImageWriter::supportedImageFormats().contains("jpeg") ? QByteArray("jpeg") : QByteArray("png");
    m_timer.setTimerType(Qt::PreciseTimer);
    m_timer.setInterval(1000 / m_options.fps);
    connect(&m_timer, &QTimer::timeout, this, [this]() { captureFrame(false); });
    computeCanvas();
}

void Recorder::computeCanvas()
{
    // the canvas covers all windows visible when recording starts; it has to stay the
    // same size for the whole video, later windows outside of it are clipped
    QRectF canvas;
    const auto windows = Element::topLevelWindows(true);
    for (QObject *w : windows) {
        QRectF r = Element::globalGeometry(w);
        if (m_options.chrome)
            r.setTop(r.top() - TitleBarHeight);
        canvas = canvas.united(r);
    }
    if (canvas.isEmpty())
        canvas = QRectF(0, 0, 800, 600);
    m_canvas = canvas;

    if (m_options.size.isValid() && !m_options.size.isEmpty()) {
        m_frameSize = QSize(even(m_options.size.width()), even(m_options.size.height()));
        m_scale = std::min(m_frameSize.width() / canvas.width(), m_frameSize.height() / canvas.height());
        m_offset = QPointF((m_frameSize.width() - canvas.width() * m_scale) / 2.0,
                           (m_frameSize.height() - canvas.height() * m_scale) / 2.0);
    } else {
        m_scale = m_options.scale;
        m_frameSize = QSize(even(canvas.width() * m_scale), even(canvas.height() * m_scale));
        m_offset = QPointF();
    }
}

void Recorder::start()
{
    m_clock.start();
    captureFrame(true);
    m_timer.start();
}

void Recorder::stop()
{
    m_timer.stop();
    captureFrame(true);
}

static void drawPointer(QPainter &p, QPointF tip, qreal scale, bool pressed)
{
    // a classic arrow cursor, kept at a constant on-screen size
    p.save();
    p.translate(tip);
    p.scale(1.0 / scale, 1.0 / scale);
    if (pressed) {
        p.setPen(Qt::NoPen);
        p.setBrush(QColor(255, 80, 80, 110));
        p.drawEllipse(QPointF(0, 0), 14, 14);
    }
    QPainterPath arrow;
    arrow.moveTo(0, 0);
    arrow.lineTo(0, 17);
    arrow.lineTo(4.5, 13);
    arrow.lineTo(7.5, 20);
    arrow.lineTo(10, 19);
    arrow.lineTo(7, 12);
    arrow.lineTo(12.5, 12);
    arrow.closeSubpath();
    p.setRenderHint(QPainter::Antialiasing);
    p.setPen(QPen(Qt::white, 1.5));
    p.setBrush(Qt::black);
    p.drawPath(arrow);
    p.restore();
}

QImage Recorder::compose()
{
    QImage frame(m_frameSize, QImage::Format_RGB32);
    frame.fill(QColor(0x2b, 0x2b, 0x2b));
    QPainter p(&frame);
    p.setRenderHint(QPainter::SmoothPixmapTransform);
    p.translate(m_offset);
    p.scale(m_scale, m_scale);
    p.translate(-m_canvas.topLeft());

    QFont titleFont = p.font();
    titleFont.setPixelSize(12);
    const auto windows = windowsInStackingOrder();
    for (QObject *w : windows) {
        const QRectF geometry = Element::globalGeometry(w);
        if (m_options.chrome) {
            const QRectF bar(geometry.left(), geometry.top() - TitleBarHeight, geometry.width(), TitleBarHeight);
            const bool active = stackingRank(w) > 0;
            p.fillRect(bar, active ? QColor(0x3d, 0x5a, 0x80) : QColor(0x4a, 0x4a, 0x4a));
            p.setPen(Qt::white);
            p.setFont(titleFont);
            p.drawText(bar.adjusted(8, 0, -8, 0), Qt::AlignVCenter | Qt::AlignLeft, Element::windowTitle(w));
        }
        QString error;
        const QImage img = Element::grab(w, true, &error);
        if (!img.isNull())
            p.drawImage(geometry, img);
    }

    if (m_options.cursor) {
        const auto pointer = Input::pointerState();
        if (pointer.window && pointer.window->isVisible())
            drawPointer(p, pointer.window->mapToGlobal(pointer.pos), m_scale, pointer.buttons != Qt::NoButton);
    }
    return frame;
}

void Recorder::captureFrame(bool force)
{
    const QImage frame = compose();
    if (!force && frame == m_lastFrame)
        return; // unchanged; the consumer repeats the previous frame
    m_lastFrame = frame;

    QByteArray data(20, '\0');
    memcpy(data.data(), "QTPW", 4);
    data[4] = m_format == "jpeg" ? 'J' : 'P';
    qToLittleEndian<quint32>(m_id, data.data() + 8);
    qToLittleEndian<double>(double(m_clock.elapsed()), data.data() + 12);
    QBuffer buffer(&data);
    buffer.open(QIODevice::Append);
    QImageWriter writer(&buffer, m_format);
    if (m_format == "jpeg")
        writer.setQuality(m_options.quality);
    writer.write(frame);
    buffer.close();

    if (m_sink(data))
        ++m_framesSent;
    else
        m_lastFrame = QImage(); // dropped: make sure the next frame is sent
}
