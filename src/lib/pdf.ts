"use client";

import { jsPDF } from "jspdf";
import { finalReportDisclaimer, safetyDisclaimer } from "./report-templates";
import type { AiResult, Patient, Profile, Report, Scan } from "./types";
import { getPatientAccessId, type PublicReportResult } from "./report-access";

function reportStatusLabel(status: string) {
  if (status === "pending_review") return "Pending Review";
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function patientSafeReportText(value: string) {
  return value
    .replace(/AI-assisted classification suggests/gi, "Doctor-reviewed results show")
    .replace(/based on AI-assisted analysis/gi, "after doctor review")
    .replace(/AI-assisted/g, "Doctor-reviewed")
    .replace(/\bAI\b/g, "doctor-reviewed analysis");
}

export function downloadReportPdf(args: {
  patient: Patient;
  scan: Scan;
  aiResult: AiResult;
  report: Report;
  approver?: Profile;
}) {
  const { patient, scan, aiResult, report, approver } = args;
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const margin = 48;
  let y = 52;
  const safeDate = new Date().toISOString().slice(0, 10);

  doc.setFillColor(10, 93, 110);
  doc.rect(0, 0, 595, 96, "F");
  doc.setTextColor(255, 255, 255);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(19);
  doc.text("OCT AI", margin, y);
  doc.setFontSize(14);
  doc.text("CLINICAL SCREENING REPORT", margin, y + 20);
  doc.setFontSize(9);
  doc.text("AFIO Ophthalmology Workflow System - Confidential medical document", margin, y + 38);
  doc.setFont("helvetica", "bold");
  doc.text(report.status === "approved" ? "DOCTOR REVIEWED" : "DRAFT - NOT APPROVED", 430, y + 4);

  if (report.status !== "approved") {
    doc.setTextColor(220, 38, 38);
    doc.setFontSize(24);
    doc.text("DRAFT - NOT APPROVED", 168, 185, { angle: -18 });
  }

  y = 122;
  doc.setTextColor(23, 32, 51);
  doc.setFillColor(241, 245, 249);
  doc.roundedRect(margin, y - 16, 499, 78, 5, 5, "F");
  doc.setFont("helvetica", "bold");
  doc.setFontSize(11);
  doc.text("SCAN METADATA", margin + 14, y);
  doc.setFont("helvetica", "normal");
  doc.text(`Scan ID: ${scan.id.slice(0, 12)}`, margin + 14, y + 20);
  doc.text(`Date: ${new Date(scan.createdAt).toLocaleDateString()}`, margin + 170, y + 20);
  doc.text(`Eye examined: ${scan.eyeSide}`, margin + 320, y + 20);
  doc.text(`Model: ${aiResult.modelName} ${aiResult.modelVersion}`, margin + 14, y + 40);
  doc.text(`Status: ${reportStatusLabel(report.status)}`, margin + 320, y + 40);

  y += 92;
  doc.setFont("helvetica", "bold");
  doc.text("PATIENT INFORMATION", margin, y);
  doc.setFont("helvetica", "normal");
  doc.text(`Patient name: ${patient.fullName}`, margin, y + 20);
  doc.text(`Patient ID: ${getPatientAccessId(patient)}`, margin, y + 38);
  doc.text(`Age/Gender: ${patient.age} / ${patient.gender}`, 320, y + 20);
  doc.text(`Scan type: ${scan.scanType}`, 320, y + 38);

  y += 78;
  doc.setFont("helvetica", "bold");
  doc.text("AI MODEL OUTPUT", margin, y);
  doc.setFont("helvetica", "normal");
  doc.text(`Classification: ${aiResult.predictedClass}`, margin, y + 20);
  doc.text(`Confidence: ${Math.round(aiResult.confidence * 100)}%`, margin + 190, y + 20);
  doc.text(safetyDisclaimer, margin, y + 42, { maxWidth: 500 });

  y += 70;
  doc.setFont("helvetica", "bold");
  doc.text("GRAD-CAM ATTENTION HEATMAP", margin, y);
  doc.setFont("helvetica", "normal");
  doc.text(
    aiResult.heatmapUrl
      ? "Grad-CAM overlay was generated and is available in the scan analysis view. Highlighted regions indicate areas that influenced the AI classification."
      : "Grad-CAM overlay was not generated for this report. Enable the backend Grad-CAM worker for heatmap testing.",
    margin,
    y + 18,
    { maxWidth: 500 }
  );

  y += 72;
  const sections = [
    ["Findings", report.findings],
    ["Impression", report.impression],
    ["Recommendation", report.recommendation],
    ["Doctor Notes", report.doctorNotes || "No additional notes."],
    ["Final Diagnosis", report.finalDiagnosis]
  ];

  sections.forEach(([title, body]) => {
    doc.setFont("helvetica", "bold");
    doc.text(title, margin, y);
    doc.setFont("helvetica", "normal");
    const wrapped = doc.splitTextToSize(body, 500);
    doc.text(wrapped, margin, y + 18);
    y += 32 + wrapped.length * 12;
  });

  doc.setFont("helvetica", "bold");
  doc.text("CLINICAL REVIEW", margin, y + 4);
  doc.setFont("helvetica", "normal");
  doc.text(`Status: ${report.status}`, margin, y + 22);
  doc.text(`Approved by: ${approver?.fullName ?? "Not approved"}`, margin, y + 40);
  doc.text(`Approved at: ${report.approvedAt ? new Date(report.approvedAt).toLocaleString() : "Not approved"}`, margin, y + 58);

  doc.setFontSize(8);
  doc.setTextColor(71, 85, 105);
  doc.text(finalReportDisclaimer, margin, 780, { maxWidth: 500 });
  doc.text(`OCT AI - AFIO Platform - Page 1 of 1 - ${safeDate}`, margin, 812);

  doc.save(`OCT_Report_${getPatientAccessId(patient)}_${safeDate}.pdf`);
}

export function downloadPublicReportPdf(report: NonNullable<PublicReportResult["report"]>) {
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const margin = 48;
  let y = 52;
  const statusLabel = reportStatusLabel(report.status);
  const patientCopyTitle =
    report.status === "approved"
      ? "Doctor-Approved OCT Report"
      : report.status === "rejected"
        ? "Rejected OCT Report"
        : report.status === "superseded"
          ? "Superseded OCT Report"
          : "OCT Report";

  doc.setFillColor(16, 119, 131);
  doc.rect(0, 0, 595, 82, "F");
  doc.setTextColor(255, 255, 255);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(18);
  doc.text(patientCopyTitle, margin, y);
  doc.setFontSize(9);
  doc.text(`${statusLabel} patient copy`, margin, y + 18);

  y = 116;
  doc.setTextColor(23, 32, 51);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(11);
  doc.text("Patient Information", margin, y);
  doc.setFont("helvetica", "normal");
  doc.text(`Access ID: ${report.patientCode}`, margin, y + 20);
  doc.text(`Name: ${report.patientName}`, margin, y + 38);
  doc.text(`Age/Gender: ${report.age ?? "-"} / ${report.gender ?? "-"}`, margin, y + 56);
  doc.text(`Status: ${statusLabel}`, 320, y + 20);
  doc.text(`Review date: ${report.approvedAt || report.createdAt ? new Date(report.approvedAt ?? report.createdAt ?? "").toLocaleString() : "-"}`, 320, y + 38);
  doc.text(`Reviewed by: ${report.approvedByName ?? "Doctor"}`, 320, y + 56);

  y += 92;
  doc.setFont("helvetica", "bold");
  doc.text("Results", margin, y);
  doc.setFont("helvetica", "normal");
  doc.text(`Results: ${report.result || report.finalDiagnosis || "-"}`, margin, y + 22);

  y += 58;
  const sections = [
    ["Findings", patientSafeReportText(report.findings)],
    ["Impression", patientSafeReportText(report.impression)],
    ["Recommendation", patientSafeReportText(report.recommendation)],
    ["Doctor Notes", patientSafeReportText(report.doctorNotes || "No additional notes.")],
    ["Final Diagnosis", report.result || report.finalDiagnosis]
  ];

  sections.forEach(([title, body]) => {
    doc.setFont("helvetica", "bold");
    doc.text(title, margin, y);
    doc.setFont("helvetica", "normal");
    const wrapped = doc.splitTextToSize(body, 500);
    doc.text(wrapped, margin, y + 18);
    y += 32 + wrapped.length * 12;
  });

  doc.setFontSize(8);
  doc.setTextColor(71, 85, 105);
  doc.text(finalReportDisclaimer, margin, 780, { maxWidth: 500 });
  doc.text("Generated by OCT AI Report Assistant", margin, 812);

  const safeDate = new Date().toISOString().slice(0, 10);
  doc.save(`OCT_Report_${report.patientCode}_${safeDate}.pdf`);
}
