//! The prompt editor: a small multi-line buffer with a cursor and history.

use unicode_width::UnicodeWidthChar;

#[derive(Default)]
pub struct Input {
    chars: Vec<char>,
    cursor: usize,
    history: Vec<String>,
    /// Position while browsing history; `None` = editing a fresh line.
    browsing: Option<usize>,
    draft: String,
}

impl Input {
    pub fn text(&self) -> String {
        self.chars.iter().collect()
    }

    pub fn is_empty(&self) -> bool {
        self.chars.is_empty()
    }

    pub fn set(&mut self, text: &str) {
        self.chars = text.chars().collect();
        self.cursor = self.chars.len();
    }

    pub fn clear(&mut self) {
        self.chars.clear();
        self.cursor = 0;
        self.browsing = None;
    }

    /// Take the text for sending and remember it in history.
    pub fn take(&mut self) -> String {
        let text = self.text();
        if !text.trim().is_empty() && self.history.last() != Some(&text) {
            self.history.push(text.clone());
        }
        self.clear();
        text
    }

    pub fn insert(&mut self, ch: char) {
        self.chars.insert(self.cursor, ch);
        self.cursor += 1;
        self.browsing = None;
    }

    pub fn insert_str(&mut self, text: &str) {
        for ch in text.chars().filter(|ch| *ch != '\r') {
            self.insert(ch);
        }
    }

    pub fn backspace(&mut self) {
        if self.cursor > 0 {
            self.cursor -= 1;
            self.chars.remove(self.cursor);
        }
    }

    pub fn delete(&mut self) {
        if self.cursor < self.chars.len() {
            self.chars.remove(self.cursor);
        }
    }

    pub fn left(&mut self) {
        self.cursor = self.cursor.saturating_sub(1);
    }

    pub fn right(&mut self) {
        self.cursor = (self.cursor + 1).min(self.chars.len());
    }

    pub fn home(&mut self) {
        while self.cursor > 0 && self.chars[self.cursor - 1] != '\n' {
            self.cursor -= 1;
        }
    }

    pub fn end(&mut self) {
        while self.cursor < self.chars.len() && self.chars[self.cursor] != '\n' {
            self.cursor += 1;
        }
    }

    /// Ctrl+U: delete to the start of the line.
    pub fn kill_to_start(&mut self) {
        let end = self.cursor;
        self.home();
        self.chars.drain(self.cursor..end);
    }

    /// Ctrl+W: delete the word before the cursor.
    pub fn kill_word(&mut self) {
        let end = self.cursor;
        while self.cursor > 0 && self.chars[self.cursor - 1] == ' ' {
            self.cursor -= 1;
        }
        while self.cursor > 0
            && self.chars[self.cursor - 1] != ' '
            && self.chars[self.cursor - 1] != '\n'
        {
            self.cursor -= 1;
        }
        self.chars.drain(self.cursor..end);
    }

    pub fn is_multiline(&self) -> bool {
        self.chars.contains(&'\n')
    }

    pub fn history_prev(&mut self) {
        if self.history.is_empty() {
            return;
        }
        let next = match self.browsing {
            None => {
                self.draft = self.text();
                self.history.len() - 1
            }
            Some(0) => 0,
            Some(index) => index - 1,
        };
        self.browsing = Some(next);
        let text = self.history[next].clone();
        self.set(&text);
        self.browsing = Some(next);
    }

    pub fn history_next(&mut self) {
        let Some(index) = self.browsing else { return };
        if index + 1 < self.history.len() {
            let text = self.history[index + 1].clone();
            self.set(&text);
            self.browsing = Some(index + 1);
        } else {
            let draft = std::mem::take(&mut self.draft);
            self.set(&draft);
            self.browsing = None;
        }
    }

    /// Lay the text out in rows of `width` columns. Returns the rows and the
    /// cursor's `(column, row)`.
    pub fn layout(&self, width: usize) -> (Vec<String>, (usize, usize)) {
        let width = width.max(4);
        let mut rows = vec![String::new()];
        let mut col = 0usize;
        let mut cursor = (0, 0);
        for (index, ch) in self.chars.iter().enumerate() {
            if index == self.cursor {
                cursor = (col, rows.len() - 1);
            }
            if *ch == '\n' {
                rows.push(String::new());
                col = 0;
                continue;
            }
            let w = ch.width().unwrap_or(0);
            if col + w > width {
                rows.push(String::new());
                col = 0;
            }
            rows.last_mut().expect("at least one row").push(*ch);
            col += w;
        }
        if self.cursor == self.chars.len() {
            if col >= width {
                rows.push(String::new());
                col = 0;
            }
            cursor = (col, rows.len() - 1);
        }
        (rows, cursor)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn editing_and_history() {
        let mut input = Input::default();
        input.insert_str("hello world");
        input.kill_word();
        assert_eq!(input.text(), "hello ");
        assert_eq!(input.take(), "hello ");
        input.insert_str("draft");
        input.history_prev();
        assert_eq!(input.text(), "hello ");
        input.history_next();
        assert_eq!(input.text(), "draft");
    }

    #[test]
    fn layout_tracks_cursor_across_wraps_and_newlines() {
        let mut input = Input::default();
        input.insert_str("abcdef\nxy");
        let (rows, cursor) = input.layout(4);
        assert_eq!(rows, vec!["abcd", "ef", "xy"]);
        assert_eq!(cursor, (2, 2));
    }
}
