"use client";

import type { FeedbackEntry, FeedbackResponse } from "./types";

const FEEDBACK_KEY = "oct-ai-report-assistant-feedback-v1";
let cachedFeedbackEntries: FeedbackEntry[] | null = null;

function backendBaseUrl() {
  const url = process.env.NEXT_PUBLIC_AI_BACKEND_URL;
  if (!url) throw new Error("AI backend URL is not configured.");
  return url.replace(/\/$/, "");
}

async function readError(response: Response, fallback: string) {
  try {
    const body = await response.json();
    return body.detail || body.message || fallback;
  } catch {
    return fallback;
  }
}

function readEntries(): FeedbackEntry[] {
  if (typeof window === "undefined") return [];
  const raw = window.localStorage.getItem(FEEDBACK_KEY);
  if (!raw) return [];
  try {
    return JSON.parse(raw) as FeedbackEntry[];
  } catch {
    return [];
  }
}

export async function getFeedbackEntries() {
  try {
    const response = await fetch(`${backendBaseUrl()}/feedback`, { cache: "no-store" });
    if (!response.ok) throw new Error(await readError(response, "Could not load feedback."));
    const body = await response.json();
    cachedFeedbackEntries = (body.entries ?? []) as FeedbackEntry[];
    return cachedFeedbackEntries;
  } catch {
    cachedFeedbackEntries = cachedFeedbackEntries ?? readEntries();
    return cachedFeedbackEntries;
  }
}

export function getCachedFeedbackEntries() {
  cachedFeedbackEntries = cachedFeedbackEntries ?? readEntries();
  return cachedFeedbackEntries;
}

export async function submitFeedback(input: Omit<FeedbackEntry, "id" | "status" | "createdAt">) {
  try {
    const response = await fetch(`${backendBaseUrl()}/feedback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: input.type,
        clinic_id: input.clinicId || null,
        hospital_name: input.hospitalName || null,
        module_id: input.moduleId || null,
        name: input.name,
        email: input.email || null,
        phone: input.phone || null,
        patient_code: input.patientCode || null,
        report_id: input.reportId || null,
        message: input.message
      })
    });
    if (!response.ok) throw new Error(await readError(response, "Could not submit feedback."));
    const body = await response.json();
    cachedFeedbackEntries = null;
    return body.entry as FeedbackEntry;
  } catch (error) {
    throw error;
  }
}

export async function updateFeedbackStatus(id: string, status: FeedbackEntry["status"]) {
  const response = await fetch(`${backendBaseUrl()}/feedback/${id}/status`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status })
  });
  if (!response.ok) throw new Error(await readError(response, "Could not update feedback status."));
  return getFeedbackEntries();
}

export async function addFeedbackResponse(id: string, input: Omit<FeedbackResponse, "id" | "createdAt">) {
  const response = await fetch(`${backendBaseUrl()}/feedback/${id}/responses`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      responder_name: input.responderName,
      message: input.message
    })
  });
  if (!response.ok) throw new Error(await readError(response, "Could not save feedback response."));
  return getFeedbackEntries();
}
