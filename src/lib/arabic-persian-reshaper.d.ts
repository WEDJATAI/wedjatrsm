// Type declarations for the untyped arabic-persian-reshaper package
// (used by report-pdf.ts for Arabic presentation-forms shaping on the
// jsPDF canvas, which has no bidi engine of its own).
declare module 'arabic-persian-reshaper' {
  export const ArabicShaper: {
    /** Reshape Arabic letters to their joined presentation forms (logical order). */
    convertArabic(text: string): string
    convertArabicBack(text: string): string
  }
  export const PersianShaper: {
    convertArabic(text: string): string
    convertArabicBack(text: string): string
  }
}
