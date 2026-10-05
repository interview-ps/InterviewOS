export function defineSkill(def) {
  Object.defineProperty(def, "__interviewOsSkill", {
    value: 1,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return def;
}

export function isInterviewOsSkill(value) {
  return (
    typeof value === "object" && value !== null && value.__interviewOsSkill === 1
  );
}
