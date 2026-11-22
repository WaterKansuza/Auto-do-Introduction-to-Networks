"""Extract NetAcad checkpoint questions into Markdown with an Answer template."""
from __future__ import annotations

import argparse
import re
from pathlib import Path
from time import monotonic, sleep

from playwright.sync_api import BrowserContext, Frame, Locator, sync_playwright

COURSE_URL = (
    "https://www.netacad.com/launch?"
    "id=272da87c-c2e2-45e5-80a6-e5aa71303027"
    "&tab=curriculum"
    "&view=2ef75b2c-402c-5a6d-84b4-e814ed46b8a8"
)
BASE_DIR = Path(__file__).resolve().parent
OUTPUT_FILE = BASE_DIR / "QuestionAfterTake.md"
PROFILE_DIR = BASE_DIR / ".netacad-browser"

NOISE_LINE_RE = re.compile(
    r"^(?:(?:in)?complete(?:\s+question)?|question(?:\s*\d+)?|correct|incorrect)$",
    re.IGNORECASE,
)
PREFIX_NOISE_RE = re.compile(
    r"^(?:in)?complete\s+question\s*:?\s*",
    re.IGNORECASE,
)


def normalize_spaces(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def clean_choice(text: str) -> str:
    """Remove accessibility position suffix (e.g., '1 of 4') from an answer."""
    cleaned = normalize_spaces(text)
    return re.sub(r"\s+\d+\s+of\s+\d+\s*$", "", cleaned).strip()


def clean_stem_text(text: str) -> str:
    """Strip 'Complete Question' / 'Incomplete Question' screen-reader artifacts."""
    cleaned_lines: list[str] = []
    for line in text.splitlines():
        normalized = normalize_spaces(line)
        if not normalized or NOISE_LINE_RE.match(normalized):
            continue
        line_without_prefix = PREFIX_NOISE_RE.sub("", line).strip()
        if line_without_prefix:
            cleaned_lines.append(line_without_prefix)
    return "\n".join(cleaned_lines).strip()


def wait_for_content_frame(context: BrowserContext, timeout_sec: int = 180) -> Frame:
    """Poll all open pages and frames until the NetAcad content iframe renders questions."""
    deadline = monotonic() + timeout_sec
    target_frame: Frame | None = None
    notified_login = False

    while monotonic() < deadline:
        for page in context.pages:
            if "auth.netacad.com" in page.url and not notified_login:
                print("Đang ở trang đăng nhập. Hãy đăng nhập trên trình duyệt...")
                notified_login = True

            for frame in page.frames:
                if re.search(r"/authoring-resources/index\.html", frame.url):
                    target_frame = frame
                    break
                try:
                    if frame.locator(".component__inner.is-question").count() > 0:
                        target_frame = frame
                        break
                except Exception:
                    continue
            if target_frame is not None:
                break

        if target_frame is not None:
            try:
                count = target_frame.locator(".component__inner.is-question").count()
                if count > 0:
                    target_frame.evaluate("window.scrollTo(0, document.body.scrollHeight)")
                    sleep(1.5)
                    new_count = target_frame.locator(".component__inner.is-question").count()
                    if new_count == count:
                        return target_frame
            except Exception:
                target_frame = None

        sleep(1.0)

    raise RuntimeError(
        "Hết thời gian chờ iframe nội dung khóa học (/authoring-resources/index.html) "
        "hoặc trang chưa mở đúng bài Checkpoint."
    )


def extract_clean_dom_text(locator: Locator) -> str:
    """Extract text while removing screen-reader labels and preserving <pre> blocks."""
    return locator.evaluate(
        """(el) => {
            const clone = el.cloneNode(true);
            clone.querySelectorAll('.aria-label, .visually-hidden, .sr-only').forEach((n) => n.remove());
            clone.querySelectorAll('pre').forEach((pre) => {
                const code = pre.innerText.trim();
                pre.replaceWith(`\\n\\n\`\`\`text\\n${code}\\n\`\`\`\\n\\n`);
            });
            return clone.innerText.replace(/\\u00a0/g, ' ').replace(/\\n{3,}/g, '\\n\\n').trim();
        }"""
    )


def extract_question_text(component: Locator) -> str:
    """Extract question stem without 'Complete Question' status text."""
    parts: list[str] = []

    title_locator = component.locator(".component__title-inner")
    if title_locator.count() > 0:
        for idx in range(title_locator.count()):
            raw_title = extract_clean_dom_text(title_locator.nth(idx))
            cleaned_title = clean_stem_text(raw_title)
            if cleaned_title and cleaned_title not in parts:
                parts.append(cleaned_title)
    else:
        header_locator = component.locator(".component__header-container")
        if header_locator.count() > 0:
            raw_header = extract_clean_dom_text(header_locator.first)
            cleaned_header = clean_stem_text(raw_header)
            if cleaned_header and cleaned_header not in parts:
                parts.append(cleaned_header)

    body_locator = component.locator(".component__body-inner")
    if body_locator.count() > 0:
        raw_body = extract_clean_dom_text(body_locator.first)
        cleaned_body = clean_stem_text(raw_body)
        if cleaned_body and cleaned_body not in parts:
            parts.append(cleaned_body)

    return "\n\n".join(parts).strip()


def extract_questions(frame: Frame) -> list[dict[str, object]]:
    questions: list[dict[str, object]] = []
    components = frame.locator(".component__inner.is-question")
    total = components.count()

    for index in range(total):
        component = components.nth(index)
        question = extract_question_text(component)

        item: dict[str, object] = {
            "number": index + 1,
            "question": question,
            "answers": [],
        }

        if component.locator(".mcq__item-text-inner").count() > 0:
            item["answers"] = [
                clean_choice(text)
                for text in component.locator(".mcq__item-text-inner").all_inner_texts()
                if normalize_spaces(text)
            ]
        elif component.locator(".objectMatching__widget").count() > 0:
            categories = component.locator(
                ".objectMatching-category-item-container .category-item-text"
            ).all_inner_texts()
            options = component.locator(
                ".objectMatching-option-item-container .category-item-text"
            ).all_inner_texts()
            item["categories"] = [normalize_spaces(text) for text in categories if normalize_spaces(text)]
            item["options"] = [normalize_spaces(text) for text in options if normalize_spaces(text)]

        questions.append(item)

    if not questions:
        raise RuntimeError("Không trích xuất được câu hỏi nào từ trang NetAcad.")
    return questions


def write_markdown(questions: list[dict[str, object]], output_file: Path) -> None:
    lines = ["# NetAcad Checkpoint Exam", ""]
    for item in questions:
        lines.extend(
            [
                f"## Câu {item['number']}",
                "",
                str(item["question"]),
                "",
            ]
        )
        if "categories" in item:
            lines.append("**Categories:**")
            lines.append("")
            lines.extend(f"- {value}" for value in item["categories"])  # type: ignore[union-attr]
            lines.extend(["", "**Options:**", ""])
            lines.extend(f"- {value}" for value in item["options"])  # type: ignore[union-attr]
        else:
            lines.extend(
                f"- {value}" for value in item["answers"]  # type: ignore[union-attr]
            )
        lines.append("")

    lines.extend(["## Answer", ""])
    for item in questions:
        lines.extend([f"Câu {item['number']}: ", ""])

    output_file.write_text("\n".join(lines).rstrip() + "\n", encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--output",
        type=Path,
        default=OUTPUT_FILE,
        help="Output Markdown path.",
    )
    args = parser.parse_args()

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch_persistent_context(
            str(PROFILE_DIR),
            headless=False,
        )
        page = browser.pages[0] if browser.pages else browser.new_page()
        page.goto(COURSE_URL, wait_until="domcontentloaded")

        print("Đang chờ tải nội dung bài kiểm tra trên NetAcad...")
        frame = wait_for_content_frame(browser, timeout_sec=180)
        questions = extract_questions(frame)
        write_markdown(questions, args.output)
        print(f"Đã ghi {len(questions)} câu vào {args.output}")
        browser.close()


if __name__ == "__main__":
    main()