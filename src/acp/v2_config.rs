//! Project v2 select and boolean options into Grove's existing UI model.

use agent_client_protocol::schema::{v1, v2};

pub fn options(values: &[v2::SessionConfigOption]) -> Vec<v1::SessionConfigOption> {
    values
        .iter()
        .filter_map(|option| {
            let mut value = serde_json::to_value(option).ok()?;
            let object = value.as_object_mut()?;
            let id = object.remove("configId")?;
            object.insert("id".into(), id);
            if let Some(groups) = object
                .get_mut("options")
                .and_then(serde_json::Value::as_array_mut)
            {
                for group in groups {
                    if let Some(group) = group.as_object_mut() {
                        if let Some(id) = group.remove("groupId") {
                            group.insert("group".into(), id);
                        }
                    }
                }
            }
            serde_json::from_value(value).ok()
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn retains_select_group_identifiers_and_boolean_values() {
        let source: Vec<v2::SessionConfigOption> = serde_json::from_value(json!([
            {"configId":"mode","name":"Mode","category":"mode","type":"select","currentValue":"ask","options":[{"groupId":"g","name":"General","options":[{"value":"ask","name":"Ask"}]}]},
            {"configId":"safe","name":"Safe","type":"boolean","currentValue":true}
        ])).unwrap();
        let converted = options(&source);
        assert_eq!(converted.len(), 2);
        let json = serde_json::to_value(converted).unwrap();
        assert_eq!(json[0]["id"], "mode");
        assert_eq!(json[0]["options"][0]["group"], "g");
        assert_eq!(json[1]["currentValue"], true);
    }
}
