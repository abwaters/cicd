// Guards against drift between cicd.schema.json and the hand-maintained
// TypeScript types in src/types.ts. The two are kept in sync manually; this
// test makes the top-level contract two-way checked:
//
//  - `satisfies Record<keyof CICDConfig, true>` fails to COMPILE if CICDConfig
//    gains or renames a key that isn't reflected here.
//  - The runtime assertions fail if cicd.schema.json gains or drops a
//    top-level property that isn't reflected here.
//
// When either side changes: update the other side, then update this map.

import { CICDConfig } from '../src/types';
import * as schema from '../cicd.schema.json';

const TOP_LEVEL_KEYS = {
    app: true,
    account: true,
    region: true,
    repo: true,
    computeMode: true,
    fargate: true,
    batch: true,
    environment: true,
    environmentGroups: true,
    throttle: true,
    workers: true,
    exports: true,
    plugins: true,
    stages: true,
} as const satisfies Record<keyof CICDConfig, true>;

describe('cicd.schema.json ↔ types.ts sync', () => {
    const schemaKeys = Object.keys((schema as any).properties).sort();
    const typeKeys = Object.keys(TOP_LEVEL_KEYS).sort();

    it('every schema property exists on CICDConfig', () => {
        const missingFromTypes = schemaKeys.filter(k => !typeKeys.includes(k));
        expect(missingFromTypes).toEqual([]);
    });

    it('every CICDConfig key exists in the schema', () => {
        const missingFromSchema = typeKeys.filter(k => !schemaKeys.includes(k));
        expect(missingFromSchema).toEqual([]);
    });
});
