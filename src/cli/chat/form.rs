//! Questions an agent puts to the user mid-session.
//!
//! Two server events open one: `ask_form` (Grove's own MCP tool, answered
//! with a normal prompt the agent reads next turn) and `elicitation_request`
//! (native ACP elicitation, answered with `elicitation_response` while the
//! agent waits). Both become a [`Form`] so the terminal UI asks them the same
//! way, one question at a time, as the web chat's survey panel does.

use serde_json::{json, Map, Value};

#[derive(Debug, Clone, PartialEq)]
pub enum Source {
    AskForm,
    Elicitation,
    /// Elicitation that sends the user to a web page instead of a form.
    /// `opened` once the user accepted; the agent then waits for the page.
    Url {
        url: String,
        opened: bool,
    },
}

#[derive(Debug, Clone, PartialEq)]
pub enum Kind {
    Single,
    Multi,
    Text,
    Number { integer: bool },
    Rating,
    Boolean,
}

#[derive(Debug, Clone)]
pub struct FormOption {
    pub id: String,
    pub label: String,
    pub description: Option<String>,
}

#[derive(Debug, Clone)]
pub struct Question {
    pub id: String,
    pub title: String,
    pub description: Option<String>,
    pub kind: Kind,
    pub options: Vec<FormOption>,
    pub required: bool,
    pub minimum: Option<f64>,
    pub maximum: Option<f64>,
    pub default: Option<Answer>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Answer {
    Choice(String),
    Choices(Vec<String>),
    /// Free text: a text question, or a typed answer to an `ask_form` choice.
    Text(String),
    Number(f64),
    Rating(u8),
    Bool(bool),
}

#[derive(Debug, Clone)]
pub struct Form {
    /// `form_id` for `ask_form`, `request_id` for an elicitation.
    pub id: String,
    pub source: Source,
    pub title: String,
    pub description: Option<String>,
    /// Who is asking, when it is not the session's own agent.
    pub asker: Option<String>,
    pub message: Option<String>,
    pub questions: Vec<Question>,
    /// Server-side validation error from the last answer.
    pub error: Option<String>,
    /// ACP elicitation id, matched by `elicitation_complete`.
    pub elicitation_id: Option<String>,
    /// A form whose fields the terminal cannot ask; it can only be cancelled
    /// here (or answered in the web UI).
    pub unsupported: bool,
}

fn s(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_owned)
}

fn f(value: &Value, key: &str) -> Option<f64> {
    value.get(key).and_then(Value::as_f64)
}

impl Form {
    /// From an `ask_form` event: `{form_id, definition:{title, questions}}`.
    pub fn from_ask_form(value: &Value) -> Option<Self> {
        let id = s(value, "form_id").filter(|id| !id.is_empty())?;
        let definition = value.get("definition")?;
        let questions: Vec<Question> = definition
            .get("questions")
            .and_then(Value::as_array)?
            .iter()
            .filter_map(ask_form_question)
            .collect();
        if questions.is_empty() {
            return None;
        }
        Some(Self {
            id,
            source: Source::AskForm,
            title: s(definition, "title").unwrap_or_else(|| "Questions".into()),
            description: s(definition, "description"),
            asker: None,
            message: None,
            questions,
            error: None,
            elicitation_id: None,
            unsupported: false,
        })
    }

    /// From an `elicitation_request` event:
    /// `{request_id, agent_name, request:{mode, message, requestedSchema|url}}`.
    pub fn from_elicitation(value: &Value) -> Option<Self> {
        let id = s(value, "request_id")?;
        let request = value.get("request")?;
        let message = s(request, "message");
        let elicitation_id = s(request, "elicitationId");
        let opened = value
            .get("opened")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let base = |source, title: String, description, questions| Self {
            id: id.clone(),
            source,
            title,
            description,
            asker: None,
            message: message.clone(),
            questions,
            error: None,
            elicitation_id: elicitation_id.clone(),
            unsupported: false,
        };
        match s(request, "mode").as_deref() {
            Some("url") => Some(base(
                Source::Url {
                    url: s(request, "url").unwrap_or_default(),
                    opened,
                },
                "Open a web page".into(),
                None,
                Vec::new(),
            )),
            Some("form") => {
                let schema = request.get("requestedSchema")?;
                let required: Vec<String> = schema
                    .get("required")
                    .and_then(Value::as_array)
                    .map(|items| {
                        items
                            .iter()
                            .filter_map(|v| v.as_str().map(str::to_owned))
                            .collect()
                    })
                    .unwrap_or_default();
                let questions: Option<Vec<Question>> = schema
                    .get("properties")
                    .and_then(Value::as_object)
                    .map(|properties| {
                        properties
                            .iter()
                            .map(|(key, raw)| schema_question(key, raw, required.contains(key)))
                            .collect()
                    })
                    .unwrap_or(Some(Vec::new()));
                let mut form = base(
                    Source::Elicitation,
                    s(schema, "title").unwrap_or_else(|| "Information requested".into()),
                    s(schema, "description"),
                    questions.clone().unwrap_or_default(),
                );
                // The agent is waiting, so a form we cannot ask still shows —
                // the user can cancel it or answer it in the web UI.
                form.unsupported = questions.is_none();
                Some(form)
            }
            _ => None,
        }
    }

    pub fn is_elicitation(&self) -> bool {
        !matches!(self.source, Source::AskForm)
    }

    /// The prompt that answers an `ask_form`, worded as the web chat words it.
    pub fn answers_markdown(&self, answers: &[Option<Answer>]) -> String {
        let mut lines = vec![
            format!("Here are my answers to {}:", one_line(&self.title)),
            String::new(),
        ];
        for (index, question) in self.questions.iter().enumerate() {
            let answer = answers.get(index).and_then(Option::as_ref);
            lines.push(format!(
                "{}. {}: {}",
                index + 1,
                one_line(&question.title),
                question.describe(answer)
            ));
        }
        lines.join("\n")
    }

    /// The `content` map of an accepted elicitation.
    pub fn answers_content(&self, answers: &[Option<Answer>]) -> Value {
        let mut content = Map::new();
        for (question, answer) in self.questions.iter().zip(answers) {
            let value = match answer {
                Some(Answer::Choice(id)) | Some(Answer::Text(id)) => json!(id),
                Some(Answer::Choices(ids)) => json!(ids),
                Some(Answer::Number(n)) => match question.kind {
                    Kind::Number { integer: true } => json!(*n as i64),
                    _ => json!(n),
                },
                Some(Answer::Rating(n)) => json!(n),
                Some(Answer::Bool(b)) => json!(b),
                None => continue,
            };
            content.insert(question.id.clone(), value);
        }
        Value::Object(content)
    }
}

impl Question {
    /// Check one answer before moving on. The server validates again.
    pub fn check(&self, answer: Option<&Answer>) -> Result<(), String> {
        let Some(answer) = answer else {
            return if self.required {
                Err(format!("{} is required", self.title))
            } else {
                Ok(())
            };
        };
        if let Answer::Number(n) = answer {
            if matches!(self.kind, Kind::Number { integer: true }) && n.fract() != 0.0 {
                return Err(format!("{} must be a whole number", self.title));
            }
            if let Some(min) = self.minimum.filter(|min| n < min) {
                return Err(format!("{} must be at least {min}", self.title));
            }
            if let Some(max) = self.maximum.filter(|max| n > max) {
                return Err(format!("{} must be at most {max}", self.title));
            }
        }
        if let Answer::Choices(ids) = answer {
            if ids.is_empty() && self.required {
                return Err(format!("{} is required", self.title));
            }
        }
        Ok(())
    }

    /// Parse typed text into an answer for a text or number question.
    pub fn parse_text(&self, text: &str) -> Result<Option<Answer>, String> {
        let text = text.trim();
        if text.is_empty() {
            return Ok(None);
        }
        match self.kind {
            Kind::Number { .. } => text
                .parse::<f64>()
                .ok()
                .filter(|n| n.is_finite())
                .map(|n| Some(Answer::Number(n)))
                .ok_or_else(|| format!("{} must be a number", self.title)),
            _ => Ok(Some(Answer::Text(text.to_string()))),
        }
    }

    pub fn label(&self, id: &str) -> String {
        self.options
            .iter()
            .find(|option| option.id == id)
            .map(|option| option.label.clone())
            .unwrap_or_else(|| id.to_string())
    }

    /// One answer as plain text, for the submitted prompt and the summary.
    pub fn describe(&self, answer: Option<&Answer>) -> String {
        match answer {
            None => "(skipped)".into(),
            Some(Answer::Choice(id)) => one_line(&self.label(id)),
            Some(Answer::Choices(ids)) if ids.is_empty() => "(skipped)".into(),
            Some(Answer::Choices(ids)) => ids
                .iter()
                .map(|id| one_line(&self.label(id)))
                .collect::<Vec<_>>()
                .join(", "),
            Some(Answer::Text(text)) if matches!(self.kind, Kind::Single | Kind::Multi) => {
                format!("{} (custom)", one_line(text))
            }
            Some(Answer::Text(text)) => one_line(text),
            Some(Answer::Number(n)) => n.to_string(),
            Some(Answer::Rating(n)) => format!("{n}/5"),
            Some(Answer::Bool(true)) => "Yes".into(),
            Some(Answer::Bool(false)) => "No".into(),
        }
    }
}

fn one_line(text: &str) -> String {
    text.split(['\r', '\n'])
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

fn options(value: Option<&Value>) -> Vec<FormOption> {
    value
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| match item {
                    Value::String(id) => Some(FormOption {
                        id: id.clone(),
                        label: id.clone(),
                        description: None,
                    }),
                    _ => {
                        let id = s(item, "id").or_else(|| s(item, "const"))?;
                        Some(FormOption {
                            label: s(item, "label")
                                .or_else(|| s(item, "title"))
                                .unwrap_or_else(|| id.clone()),
                            description: s(item, "description"),
                            id,
                        })
                    }
                })
                .collect()
        })
        .unwrap_or_default()
}

fn ask_form_question(raw: &Value) -> Option<Question> {
    let kind = match s(raw, "type")?.as_str() {
        "single_choice" => Kind::Single,
        "multi_choice" => Kind::Multi,
        "text" | "textarea" => Kind::Text,
        "number" => Kind::Number {
            integer: raw.get("integer").and_then(Value::as_bool).unwrap_or(false),
        },
        "rating" => Kind::Rating,
        "boolean" => Kind::Boolean,
        _ => return None,
    };
    let default = match &kind {
        Kind::Single => s(raw, "default").map(Answer::Choice),
        Kind::Multi => raw.get("default").and_then(Value::as_array).map(|ids| {
            Answer::Choices(
                ids.iter()
                    .filter_map(|v| v.as_str().map(str::to_owned))
                    .collect(),
            )
        }),
        Kind::Text => s(raw, "default").map(Answer::Text),
        Kind::Number { .. } => f(raw, "default").map(Answer::Number),
        Kind::Boolean => raw
            .get("default")
            .and_then(Value::as_bool)
            .map(Answer::Bool),
        Kind::Rating => None,
    };
    Some(Question {
        id: s(raw, "id")?,
        title: s(raw, "title").unwrap_or_default(),
        description: s(raw, "description"),
        options: options(raw.get("options")),
        required: raw
            .get("required")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        minimum: f(raw, "minimum"),
        maximum: f(raw, "maximum"),
        default,
        kind,
    })
}

/// One JSON-schema property of an elicitation, mapped the way the web chat's
/// `elicitationToSurvey` maps it. `None` for a shape the terminal cannot ask.
fn schema_question(id: &str, raw: &Value, required: bool) -> Option<Question> {
    let mut question = Question {
        id: id.to_string(),
        title: s(raw, "title").unwrap_or_else(|| id.to_string()),
        description: s(raw, "description"),
        kind: Kind::Text,
        options: Vec::new(),
        required,
        minimum: f(raw, "minimum"),
        maximum: f(raw, "maximum"),
        default: None,
    };
    match s(raw, "type")?.as_str() {
        "string" => {
            let titled = options(raw.get("oneOf"));
            question.options = if titled.is_empty() {
                options(raw.get("enum"))
            } else {
                titled
            };
            if question.options.is_empty() {
                question.default = s(raw, "default").map(Answer::Text);
            } else {
                question.kind = Kind::Single;
                question.default = s(raw, "default").map(Answer::Choice);
            }
        }
        kind @ ("number" | "integer") => {
            question.kind = Kind::Number {
                integer: kind == "integer",
            };
            question.default = f(raw, "default").map(Answer::Number);
        }
        "boolean" => {
            question.kind = Kind::Boolean;
            question.default = raw
                .get("default")
                .and_then(Value::as_bool)
                .map(Answer::Bool);
        }
        "array" => {
            let items = raw.get("items").cloned().unwrap_or_default();
            let titled = options(items.get("anyOf"));
            question.kind = Kind::Multi;
            question.options = if titled.is_empty() {
                options(items.get("enum"))
            } else {
                titled
            };
            question.default = raw.get("default").and_then(Value::as_array).map(|ids| {
                Answer::Choices(
                    ids.iter()
                        .filter_map(|v| v.as_str().map(str::to_owned))
                        .collect(),
                )
            });
        }
        _ => return None,
    }
    Some(question)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ask_form_answers_read_like_the_web_chat() {
        let form = Form::from_ask_form(&json!({
            "type": "ask_form", "form_id": "f1",
            "definition": { "title": "Setup", "questions": [
                { "type": "single_choice", "id": "db", "title": "Database",
                  "options": [{ "id": "pg", "label": "Postgres" }, { "id": "sq", "label": "SQLite" }] },
                { "type": "multi_choice", "id": "ext", "title": "Extras",
                  "options": [{ "id": "a", "label": "Auth" }, { "id": "b", "label": "Billing" }] },
                { "type": "text", "id": "name", "title": "Name" },
                { "type": "rating", "id": "r", "title": "Confidence" },
                { "type": "boolean", "id": "ok", "title": "Ship it" }
            ]}
        }))
        .unwrap();
        let answers = vec![
            Some(Answer::Choice("pg".into())),
            Some(Answer::Choices(vec!["a".into(), "b".into()])),
            None,
            Some(Answer::Rating(4)),
            Some(Answer::Bool(true)),
        ];
        assert_eq!(
            form.answers_markdown(&answers),
            "Here are my answers to Setup:\n\n1. Database: Postgres\n2. Extras: Auth, Billing\n3. Name: (skipped)\n4. Confidence: 4/5\n5. Ship it: Yes"
        );
    }

    #[test]
    fn elicitation_schema_maps_to_questions_and_content() {
        let form = Form::from_elicitation(&json!({
            "type": "elicitation_request", "request_id": "r1", "agent_name": "Claude",
            "request": { "mode": "form", "message": "Need details", "requestedSchema": {
                "type": "object",
                "properties": {
                    "env": { "type": "string", "title": "Environment",
                             "oneOf": [{ "const": "prod", "title": "Production" }, { "const": "dev", "title": "Dev" }] },
                    "count": { "type": "integer", "minimum": 1 },
                    "tags": { "type": "array", "items": { "enum": ["x", "y"] } },
                    "force": { "type": "boolean" }
                },
                "required": ["env"]
            }}
        }))
        .unwrap();
        assert_eq!(form.questions.len(), 4);
        let env = &form.questions[0];
        assert_eq!(env.kind, Kind::Single);
        assert!(env.required);
        assert!(env.check(None).is_err());
        let count = &form.questions[1];
        assert!(count.check(Some(&Answer::Number(0.0))).is_err());
        assert!(count.check(Some(&Answer::Number(1.5))).is_err());
        let content = form.answers_content(&[
            Some(Answer::Choice("prod".into())),
            Some(Answer::Number(3.0)),
            Some(Answer::Choices(vec!["y".into()])),
            None,
        ]);
        assert_eq!(content, json!({ "env": "prod", "count": 3, "tags": ["y"] }));
    }

    #[test]
    fn url_elicitation_and_unsupported_shapes() {
        let url = Form::from_elicitation(&json!({
            "request_id": "u", "agent_name": "a",
            "request": { "mode": "url", "message": "Sign in", "url": "https://example.com", "elicitationId": "e1" }
        }))
        .unwrap();
        assert!(matches!(url.source, Source::Url { opened: false, .. }));
        assert_eq!(url.elicitation_id.as_deref(), Some("e1"));
        let nested = Form::from_elicitation(&json!({
            "request_id": "n", "agent_name": "a",
            "request": { "mode": "form", "message": "m", "requestedSchema": {
                "properties": { "obj": { "type": "object" } } } }
        }))
        .unwrap();
        assert!(nested.unsupported);
    }
}
