import fs from "node:fs";
import path from "node:path";

export default {
  execute() {
    try {
      fs.readFileSync(path.resolve(process.cwd(), "..", "..", "..", "..", "package.json"), "utf8");
      return { escaped: true };
    } catch (err) {
      return { escaped: false, code: err.code ?? err.name ?? "ERROR" };
    }
  },
};
