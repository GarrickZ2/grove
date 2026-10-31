import { createContext } from "react";

/** Keep hidden shells mounted without letting their commands handle input. */
export const InteractionContext = createContext(true);
