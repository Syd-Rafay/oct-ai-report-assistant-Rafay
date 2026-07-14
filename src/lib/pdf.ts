"use client";

import { jsPDF } from "jspdf";
import { approvedReportDisclaimer, finalReportDisclaimer, safetyDisclaimer } from "./report-templates";
import type { AiResult, Patient, Profile, Report, Scan } from "./types";
import { getPatientAccessId, type PublicReportResult } from "./report-access";

function reportStatusLabel(status: string) {
  if (status === "pending_review") return "Pending Review";
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function patientSafeReportText(value: string) {
  return value
    .replace(/AI model output/gi, "Clinical result")
    .replace(/AI model/gi, "screening system")
    .replace(/AI-screening features/gi, "screening features")
    .replace(/AI classification/gi, "screening result")
    .replace(/AI-assisted classification suggests/gi, "Doctor-reviewed results show")
    .replace(/based on AI-assisted analysis/gi, "after doctor review")
    .replace(/AI-assisted fundus screening suggests/gi, "Doctor-reviewed fundus screening shows")
    .replace(/AI-assisted VKG screening suggests/gi, "Doctor-reviewed VKG screening shows")
    .replace(/AI-assisted/g, "Doctor-reviewed")
    .replace(/\bAI\b/g, "clinical")
    .replace(/\bConfidence:\s*\d+%/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function drawWrappedText(doc: jsPDF, text: string, x: number, y: number, maxWidth: number, lineHeight = 12) {
  const lines = doc.splitTextToSize(text || "-", maxWidth);
  doc.text(lines, x, y);
  return lines.length * lineHeight;
}

function ensurePageSpace(doc: jsPDF, y: number, requiredHeight: number, margin: number) {
  if (y + requiredHeight <= 742) return y;
  doc.addPage();
  doc.setTextColor(23, 32, 51);
  return margin;
}

function addFooter(doc: jsPDF, margin: number, safeDate: string, pageNumber: number, pageCount: number, disclaimer: string) {
  doc.setFontSize(8);
  doc.setTextColor(71, 85, 105);
  doc.text(disclaimer, margin, 780, { maxWidth: 500 });
  doc.text(`AFIO Platform - Page ${pageNumber} of ${pageCount} - ${safeDate}`, margin, 812);
}

function reportBrand(scan: Pick<Scan, "moduleId" | "scanType">) {
  const moduleId = scan.moduleId ?? (scan.scanType === "VKG" ? "vkg" : scan.scanType === "RETINA" ? "retina" : scan.scanType === "CORNEAL" ? "corneal" : "oct");
  if (moduleId === "vkg") return { title: "VKG", filenamePrefix: "VKG_Report" };
  if (moduleId === "retina") return { title: "RetinalScan", filenamePrefix: "RetinalScan_Report" };
  if (moduleId === "corneal") return { title: "Corneal", filenamePrefix: "Corneal_Report" };
  return { title: "OCT", filenamePrefix: "OCT_Report" };
}

function cleanModelVersionForPdf(modelVersion: string) {
  return modelVersion.replace(/^retina-details:[^|]+\s\|\s?/, "");
}

function normalizeHeatmapSource(source?: string) {
  if (!source) return undefined;
  if (source.startsWith("data:image/")) return source;
  if (/^[A-Za-z0-9+/=\s]+$/.test(source) && source.length > 200) {
    return `data:image/png;base64,${source.replace(/\s/g, "")}`;
  }
  return source;
}

function dataUrlFormat(dataUrl: string) {
  if (dataUrl.startsWith("data:image/jpeg") || dataUrl.startsWith("data:image/jpg")) return "JPEG";
  if (dataUrl.startsWith("data:image/webp")) return "WEBP";
  return "PNG";
}

async function imageSourceToDataUrl(source?: string) {
  const normalized = normalizeHeatmapSource(source);
  if (!normalized) return undefined;
  if (normalized.startsWith("data:image/")) return normalized;

  const response = await fetch(normalized);
  if (!response.ok) throw new Error("Could not fetch heatmap image.");
  const blob = await response.blob();
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

export async function downloadReportPdf(args: {
  patient: Patient;
  scan: Scan;
  aiResult: AiResult;
  report: Report;
  approver?: Profile;
}) {
  const { patient, scan, aiResult, report, approver } = args;
  const isApproved = report.status === "approved";
  const brand = reportBrand(scan);
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const margin = 48;
  let y = 52;
  const safeDate = new Date().toISOString().slice(0, 10);

  doc.setFillColor(10, 93, 110);
  doc.rect(0, 0, 595, 96, "F");
  doc.setTextColor(255, 255, 255);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(19);
  doc.text(brand.title, margin, y);
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
  const heatmapDataUrl = await imageSourceToDataUrl(aiResult.heatmapUrl).catch(() => undefined);
  const modelText = isApproved ? "" : `Model: ${aiResult.modelName} ${cleanModelVersionForPdf(aiResult.modelVersion)}`.trim();
  const modelLines = isApproved ? [] : doc.splitTextToSize(modelText, 282);
  const metadataHeight = isApproved ? 76 : Math.max(92, 66 + modelLines.length * 11);
  doc.roundedRect(margin, y - 16, 499, metadataHeight, 5, 5, "F");
  doc.setFont("helvetica", "bold");
  doc.setFontSize(11);
  doc.text("SCAN METADATA", margin + 14, y);
  doc.setFont("helvetica", "normal");
  doc.text(`Scan ID: ${scan.id.slice(0, 12)}`, margin + 14, y + 20);
  doc.text(`Date: ${new Date(scan.createdAt).toLocaleDateString()}`, margin + 170, y + 20);
  doc.text(`Eye examined: ${scan.eyeSide}`, margin + 320, y + 20);
  if (isApproved) {
    doc.text(`Status: ${reportStatusLabel(report.status)}`, margin + 14, y + 40, { maxWidth: 180 });
  } else {
    doc.text(modelLines, margin + 14, y + 40);
    doc.text(`Status: ${reportStatusLabel(report.status)}`, margin + 320, y + 40, { maxWidth: 180 });
  }

  y += metadataHeight + 14;
  doc.setFont("helvetica", "bold");
  doc.text("PATIENT INFORMATION", margin, y);
  doc.setFont("helvetica", "normal");
  drawWrappedText(doc, `Patient name: ${patient.fullName}`, margin, y + 20, 220);
  doc.text(`Patient ID: ${getPatientAccessId(patient)}`, margin, y + 38);
  doc.text(`Age/Gender: ${patient.age} / ${patient.gender}`, 320, y + 20);
  doc.text(`Scan type: ${scan.scanType}`, 320, y + 38);

  y += 78;
  doc.setFont("helvetica", "bold");
  doc.text(isApproved ? "CLINICAL RESULT" : "SCREENING OUTPUT", margin, y);
  doc.setFont("helvetica", "normal");
  if (isApproved) {
    doc.text(`Screening result: ${report.finalDiagnosis}`, margin, y + 20);
    y += 48;
  } else {
    doc.text(`Classification: ${aiResult.predictedClass}`, margin, y + 20);
    doc.text(`Confidence: ${Math.round(aiResult.confidence * 100)}%`, margin + 190, y + 20);
    doc.text(safetyDisclaimer, margin, y + 42, { maxWidth: 500 });
    y += 70;
  }

  if (heatmapDataUrl || !isApproved) {
    y = ensurePageSpace(doc, y, heatmapDataUrl ? 246 : 58, margin);
    doc.setFont("helvetica", "bold");
    doc.text(isApproved ? "ATTENTION HEATMAP" : "GRAD-CAM ATTENTION HEATMAP", margin, y);
    doc.setFont("helvetica", "normal");
  }

  if (heatmapDataUrl) {
    try {
      doc.addImage(heatmapDataUrl, dataUrlFormat(heatmapDataUrl), margin, y + 18, 300, 200, undefined, "FAST");
      doc.setFontSize(9);
      doc.setTextColor(71, 85, 105);
      doc.text(
        isApproved
          ? "Highlighted regions were reviewed as part of the screening result. This is not a segmentation map or measurement."
          : "Highlighted regions influenced the screening result. This is not a segmentation map or measurement.",
        margin,
        y + 234,
        { maxWidth: 500 }
      );
      doc.setFontSize(11);
      doc.setTextColor(23, 32, 51);
      y += 264;
    } catch {
      drawWrappedText(
        doc,
        "Grad-CAM overlay was generated but could not be embedded in this PDF. View it in the scan analysis page.",
        margin,
        y + 18,
        500
      );
      y += 72;
    }
  } else if (!isApproved) {
    drawWrappedText(
      doc,
      aiResult.heatmapUrl
        ? "Grad-CAM overlay was generated and is available in the scan analysis view. Highlighted regions indicate areas that influenced the screening result."
        : "Grad-CAM overlay was not generated for this report. Enable the backend Grad-CAM worker for heatmap testing.",
      margin,
      y + 18,
      500
    );
    y += 72;
  }

  const sections = [
    ["Findings", isApproved ? patientSafeReportText(report.findings) : report.findings],
    ["Impression", isApproved ? patientSafeReportText(report.impression) : report.impression],
    ["Recommendation", isApproved ? patientSafeReportText(report.recommendation) : report.recommendation],
    ["Doctor Notes", isApproved ? patientSafeReportText(report.doctorNotes || "No additional notes.") : report.doctorNotes || "No additional notes."],
    ["Final Diagnosis", report.finalDiagnosis]
  ];

  sections.forEach(([title, body]) => {
    const wrapped = doc.splitTextToSize(body, 500);
    y = ensurePageSpace(doc, y, 32 + wrapped.length * 12, margin);
    doc.setFont("helvetica", "bold");
    doc.text(title, margin, y);
    doc.setFont("helvetica", "normal");
    doc.text(wrapped, margin, y + 18);
    y += 32 + wrapped.length * 12;
  });

  y = ensurePageSpace(doc, y, 78, margin);
  doc.setFont("helvetica", "bold");
  doc.text("CLINICAL REVIEW", margin, y + 4);
  doc.setFont("helvetica", "normal");
  doc.text(`Status: ${report.status}`, margin, y + 22);
  doc.text(`Approved by: ${approver?.fullName ?? "Not approved"}`, margin, y + 40);
  doc.text(`Approved at: ${report.approvedAt ? new Date(report.approvedAt).toLocaleString() : "Not approved"}`, margin, y + 58);

  const pageCount = doc.getNumberOfPages();
  for (let page = 1; page <= pageCount; page += 1) {
    doc.setPage(page);
    addFooter(doc, margin, safeDate, page, pageCount, isApproved ? approvedReportDisclaimer : finalReportDisclaimer);
  }

  doc.save(`${brand.filenamePrefix}_${getPatientAccessId(patient)}_${safeDate}.pdf`);
}

export function downloadPublicReportPdf(report: NonNullable<PublicReportResult["report"]>) {
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const margin = 48;
  let y = 52;
  const statusLabel = reportStatusLabel(report.status);
  const patientCopyTitle =
    report.status === "approved"
      ? "Doctor-Approved Clinical Report"
      : report.status === "rejected"
        ? "Rejected Clinical Report"
        : report.status === "superseded"
          ? "Superseded Clinical Report"
          : "Clinical Report";

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
  drawWrappedText(doc, `Name: ${report.patientName}`, margin, y + 38, 220);
  doc.text(`Age/Gender: ${report.age ?? "-"} / ${report.gender ?? "-"}`, margin, y + 56);
  doc.text(`Status: ${statusLabel}`, 320, y + 20);
  doc.text(
    `Review date: ${report.approvedAt || report.createdAt ? new Date(report.approvedAt ?? report.createdAt ?? "").toLocaleString() : "-"}`,
    320,
    y + 38,
    { maxWidth: 210 }
  );
  doc.text(`Reviewed by: ${report.approvedByName ?? "Doctor"}`, 320, y + 56, { maxWidth: 210 });

  y += 92;
  doc.setFont("helvetica", "bold");
  doc.text("Results", margin, y);
  doc.setFont("helvetica", "normal");
  drawWrappedText(doc, `Results: ${report.result || report.finalDiagnosis || "-"}`, margin, y + 22, 500);

  y += 58;
  const sections = [
    ["Findings", patientSafeReportText(report.findings)],
    ["Impression", patientSafeReportText(report.impression)],
    ["Recommendation", patientSafeReportText(report.recommendation)],
    ["Doctor Notes", patientSafeReportText(report.doctorNotes || "No additional notes.")],
    ["Final Diagnosis", report.result || report.finalDiagnosis]
  ];

  sections.forEach(([title, body]) => {
    const wrapped = doc.splitTextToSize(body, 500);
    y = ensurePageSpace(doc, y, 32 + wrapped.length * 12, margin);
    doc.setFont("helvetica", "bold");
    doc.text(title, margin, y);
    doc.setFont("helvetica", "normal");
    doc.text(wrapped, margin, y + 18);
    y += 32 + wrapped.length * 12;
  });

  const safeDate = new Date().toISOString().slice(0, 10);
  const pageCount = doc.getNumberOfPages();
  for (let page = 1; page <= pageCount; page += 1) {
    doc.setPage(page);
    addFooter(doc, margin, safeDate, page, pageCount, approvedReportDisclaimer);
  }

  doc.save(`Clinical_Report_${report.patientCode}_${safeDate}.pdf`);
}
