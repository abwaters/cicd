import * as readline from 'readline';

// Ask a yes/no/freeform question on the terminal and resolve with the trimmed,
// lowercased answer. Shared by deploy.ts (production confirmation) and
// rollback.ts (target selection + rollback confirmation).
function prompt(question: string): Promise<string> {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise(resolve => {
        rl.question(question, (answer: string) => {
            rl.close();
            resolve(answer.trim().toLowerCase());
        });
    });
}

export { prompt };
