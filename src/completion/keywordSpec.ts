import type { SqlKeyword, KeywordContext } from './sqlKeywords.js';

export interface KeywordSpec {
    name: string;
    contexts: KeywordContext[];
    syntax: string;
    description: string;
    examples: string[];
    // snippet wstawiany zamiast samej nazwy - placeholdery otwierają od razu miejsce do uzupełnienia
    snippet?: string;
}

// składa dokumentację w tym samym formacie markdown co ręcznie zapisane wpisy w sqlKeywords.ts
export function buildKeyword(spec: KeywordSpec): SqlKeyword {
    const fence = '```';
    const examples = spec.examples.map(example => `${fence}sql\n${example}\n${fence}`).join('\n\n');
    return {
        name: spec.name,
        contexts: spec.contexts,
        snippet: spec.snippet,
        signature: spec.syntax,
        documentation: `\n# ${spec.name}\n\n${fence}sql\n${spec.syntax}\n${fence}\n\n${spec.description}\n\n## Examples\n\n${examples}\n`,
    };
}
