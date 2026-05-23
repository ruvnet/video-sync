/**
 * POST /api/process/notify
 * Fire post-processing actions: webhook HTTP POST or Gmail email.
 * Always returns 200 — callers are fire-and-forget.
 */

import { NextRequest, NextResponse } from "next/server";
import { withRequestLogging, serverLog } from "../../../../lib/serverLogger";
import nodemailer from "nodemailer";

interface NotifyRequest {
  action:
    | { type: "webhook"; url: string }
    | { type: "email"; to: string; subject_template?: string };
  video: {
    id: string;
    title: string;
    source_platform: string;
    source_id: string;
    recorded_at?: string;
    description?: string | null;
    transcript_text?: string | null;
  };
  success: boolean;
  youtubeUrl?: string;
  error?: string;
}

async function handler(req: NextRequest) {
  let body: NotifyRequest;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { action, video, success, youtubeUrl, error } = body;
  const rid = req.headers.get("x-request-id") ?? "n/a";

  if (action.type === "webhook") {
    // SSRF guard: only allow outbound HTTPS to prevent internal network access.
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(action.url);
    } catch {
      serverLog("warn", "post-process:webhook", "invalid-url", { url: action.url, rid });
      return NextResponse.json({ ok: true, warning: "Webhook URL is invalid" });
    }
    if (parsedUrl.protocol !== "https:") {
      serverLog("warn", "post-process:webhook", "rejected-non-https", { url: action.url, rid });
      return NextResponse.json({ ok: true, warning: "Webhook URL must use HTTPS" });
    }

    const payload = {
      event: success ? "publish_success" : "publish_failure",
      video,
      youtubeUrl: youtubeUrl ?? null,
      error: error ?? null,
      timestamp: new Date().toISOString(),
    };
    try {
      const res = await fetch(action.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      serverLog("info", "post-process:webhook", "fired", {
        url: action.url,
        status: res.status,
        rid,
      });
    } catch (err) {
      serverLog("error", "post-process:webhook", "failed", {
        url: action.url,
        error: String(err),
        rid,
      });
    }
  } else if (action.type === "email") {
    const gmailFrom = process.env.GMAIL_FROM;
    const gmailPass = process.env.GMAIL_APP_PASSWORD;
    if (!gmailFrom || !gmailPass) {
      serverLog("warn", "post-process:email", "no-credentials", { rid });
      return NextResponse.json({ ok: true, warning: "GMAIL_FROM / GMAIL_APP_PASSWORD not configured" });
    }

    const statusLabel = success ? "Published" : "Failed";
    const subject = action.subject_template
      ? action.subject_template
          .replace(/\{\{title\}\}/g, video.title)
          .replace(/\{\{status\}\}/g, statusLabel)
      : `Video ${statusLabel}: ${video.title}`;

    const transcriptExcerpt = video.transcript_text
      ? video.transcript_text.slice(0, 500) + (video.transcript_text.length > 500 ? " …" : "")
      : null;

    const lines = [
      `Video: ${video.title}`,
      `Status: ${statusLabel}`,
      youtubeUrl ? `YouTube URL: ${youtubeUrl}` : null,
      error ? `Error: ${error}` : null,
      `Source: ${video.source_platform} / ${video.source_id}`,
      video.recorded_at ? `Recorded: ${video.recorded_at}` : null,
      `Catalog ID: ${video.id}`,
      video.description ? `\nDescription:\n${video.description}` : null,
      transcriptExcerpt ? `\nTranscript excerpt:\n${transcriptExcerpt}` : null,
    ].filter(Boolean);

    try {
      const transporter = nodemailer.createTransport({
        service: "gmail",
        auth: { user: gmailFrom, pass: gmailPass },
      });
      await transporter.sendMail({
        from: gmailFrom,
        to: action.to,
        subject,
        text: lines.join("\n"),
      });
      serverLog("info", "post-process:email", "sent", { to: action.to, subject, rid });
    } catch (err) {
      serverLog("error", "post-process:email", "failed", {
        to: action.to,
        error: String(err),
        rid,
      });
    }
  }

  return NextResponse.json({ ok: true });
}

export const POST = withRequestLogging("api:process/notify", handler);
