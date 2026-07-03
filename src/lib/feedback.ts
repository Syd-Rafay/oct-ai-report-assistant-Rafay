"use client";

import type { FeedbackEntry, FeedbackResponse } from "./types";

const FEEDBACK_KEY = "oct-ai-report-assistant-feedback-v1";

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

function writeEntries(entries: FeedbackEntry[]) {
  window.localStorage.setItem(FEEDBACK_KEY, JSON.stringify(entries));
}

export function getFeedbackEntries() {
  return readEntries();
}

export function submitFeedback(input: Omit<FeedbackEntry, "id" | "status" | "createdAt">) {
  const entry: FeedbackEntry = {
    ...input,
    id: `fb_${Math.random().toString(36).slice(2, 10)}`,
    status: "new",
    createdAt: new Date().toISOString()
  };
  writeEntries([entry, ...readEntries()]);
  return entry;
}

export function updateFeedbackStatus(id: string, status: FeedbackEntry["status"]) {
  const entries = readEntries().map((entry) => (entry.id === id ? { ...entry, status } : entry));
  writeEntries(entries);
  return entries;
}

export function addFeedbackResponse(id: string, input: Omit<FeedbackResponse, "id" | "createdAt">) {
  const response: FeedbackResponse = {
    ...input,
    id: `msg_${Math.random().toString(36).slice(2, 10)}`,
    createdAt: new Date().toISOString()
  };
  const entries = readEntries().map((entry) =>
    entry.id === id
      ? {
          ...entry,
          status: "resolved" as const,
          responses: [response, ...(entry.responses ?? [])]
        }
      : entry
  );
  writeEntries(entries);
  return entries;
}
