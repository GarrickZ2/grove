// Test fixtures for the starfield (memories and relations with known structure).
import type { MemoryEntity, MemoryRelation } from "../../../api/memory";

export function entity(id: string, score: number, tag = "topic"): MemoryEntity {
  return {
    project_id: "p", entity_id: id, file_path: `memory/${id}.md`, title: `Memory ${id}`, description: "",
    tags: [{ key: tag, value: "v" }], base_score: score, access_count: 0, score,
    created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
  };
}
export function relation(id: string, source: string, target: string, score = 60): MemoryRelation {
  return {
    id, project_id: "p", source_entity_id: source, target_entity_id: target, relation_type: "related", description: "",
    base_score: score, access_count: 0, score, created_at: "", updated_at: "",
  };
}

/** Two five-node cliques joined by one weak bridge, plus a loner. */
export function twoCliques() {
  const a = ["a1", "a2", "a3", "a4", "a5"], b = ["b1", "b2", "b3", "b4", "b5"];
  const entities = [...a.map((id, i) => entity(id, 90 - i * 10, "investing")), ...b.map((id, i) => entity(id, 85 - i * 10, "engineering")), entity("solo", 20)];
  const relations: MemoryRelation[] = [];
  for (const group of [a, b]) {
    for (let i = 0; i < group.length; i++) for (let j = i + 1; j < group.length; j++) relations.push(relation(`${group[i]}-${group[j]}`, group[i], group[j], 80));
  }
  relations.push(relation("bridge", "a5", "b5", 10));
  return { entities, relations };
}
