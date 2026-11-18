import { accessSync, constants, statSync } from "node:fs";
import { delimiter, resolve } from "node:path";

export function findRex(env: NodeJS.ProcessEnv = process.env): string | undefined {
	const dirs = [...(env.REX_BIN_DIR ? [env.REX_BIN_DIR] : []), ...(env.PATH ?? "").split(delimiter).filter(Boolean)];
	for (const dir of dirs) {
		const binary = resolve(dir, "rex");
		try {
			accessSync(binary, constants.X_OK);
			if (statSync(binary).isFile()) return binary;
		} catch { /* try the next directory */ }
	}
	return undefined;
}
