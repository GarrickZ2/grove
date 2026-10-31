import { listMemoryEntities, listMemoryRelations, getMemoryEntity, deleteMemoryEntity, listMemoryLogs, deleteMemoryLogs } from "../../api/memory";
export const memorySource = { listMemoryEntities, listMemoryRelations, getMemoryEntity, deleteMemoryEntity, listMemoryLogs, deleteMemoryLogs };
export type MemorySource = typeof memorySource;
