//! Plain-text extraction for search indexing.

use pulldown_cmark::{Event, Options, Parser, Tag, TagEnd};

#[derive(Debug, Default, Clone)]
pub struct Extracted {
    /// Readable text with block boundaries as newlines.
    pub text: String,
    pub headings: Vec<String>,
    pub words: usize,
}

pub fn extract(body: &str) -> Extracted {
    let opts = Options::ENABLE_TABLES | Options::ENABLE_STRIKETHROUGH | Options::ENABLE_TASKLISTS | Options::ENABLE_WIKILINKS;
    let mut out = Extracted::default();
    let mut heading: Option<String> = None;
    for ev in Parser::new_ext(body, opts) {
        match ev {
            Event::Text(t) | Event::Code(t) => {
                out.text.push_str(&t);
                if let Some(h) = heading.as_mut() {
                    h.push_str(&t);
                }
            }
            Event::SoftBreak | Event::HardBreak => out.text.push(' '),
            Event::Start(Tag::Heading { .. }) => heading = Some(String::new()),
            Event::End(TagEnd::Heading(_)) => {
                if let Some(h) = heading.take() {
                    out.headings.push(h.trim().to_string());
                }
                out.text.push('\n');
            }
            Event::End(TagEnd::Paragraph | TagEnd::Item | TagEnd::CodeBlock | TagEnd::TableCell | TagEnd::BlockQuote(_)) => out.text.push('\n'),
            Event::Html(h) | Event::InlineHtml(h) => {
                out.text.push_str(&h);
            }
            _ => {}
        }
    }
    out.words = out.text.split_whitespace().count();
    out
}

#[cfg(test)]
mod tests {
    #[test]
    fn extracts_text_and_headings() {
        let e = super::extract("# Título **forte**\n\nUm [link](a.md) e `code`.\n\n- item\n");
        assert_eq!(e.headings, vec!["Título forte"]);
        assert!(e.text.contains("Um link e code."));
        assert!(e.text.contains("item"));
        assert_eq!(e.words, 7);
    }
}
