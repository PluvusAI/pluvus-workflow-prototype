# System packages for the Pluvus Agent Repl (Python / FastAPI).
#
# These are the non-pip binaries the OCR brief fallback needs at runtime
# (BRIEF_OCR_FALLBACK_ENABLED — dark by default). app/brief.py shells out to
# OCRmyPDF, which drives Tesseract (the OCR engine) and qpdf (PDF structure).
# The pip packages (ocrmypdf, pypdfium2) come from pyproject `.[ai]`; these three
# binaries cannot, so they live here. English language data ships with the
# tesseract package. All optional: with the flag off none of this is touched, and
# a missing binary degrades to "no extra knowledge" rather than breaking a run.
{ pkgs }: {
  deps = [
    pkgs.tesseract   # OCR engine (bundles eng traineddata)
    pkgs.qpdf        # PDF structure handling used by OCRmyPDF
  ];
}
