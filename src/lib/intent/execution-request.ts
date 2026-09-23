// Routing evidence only. Tool-level policy remains authoritative for every action.
export function isNonMutatingRequest(message: string): boolean {
  const text = message.trim().toLowerCase();
  return /^(?:please\s+)?(?:explain|describe|summarize|analyse|analyze|inspect|review|plan|propose)\b/.test(text)
    || /^(?:please\s+)?(?:write|draft|create|prepare|generate|give me)\s+(?:(?:a|an|the|some)\s+)?(?:(?:implementation|technical|detailed|code|change|safe|smallest)\s+)*(?:plan|proposal|explanation|analysis|summary|outline|recommendation|description)\b/.test(text);
}

export function isPlanContinuation(message: string): boolean {
  return /^(?:approved(?: for tier \d+(?: only)?)?(?:[, .]+(?:proceed|go ahead))?|proceed|go ahead|apply the changes we agreed|implement the plan(?: we just agreed)?)[.!\s]*$/i.test(message.trim());
}

function hasPendingImplementationPlan(context: string): boolean {
  // Only the most recent user/proposal pair can support a bare approval.
  const turns = context.slice(-16000).split(/^(?:User|user|Cr8or AI|assistant):\s*/m);
  const roles = [...context.slice(-16000).matchAll(/^(User|user|Cr8or AI|assistant):\s*/gm)].map(match => match[1].toLowerCase());
  if (roles.length < 2 || roles.at(-2) !== "user" || !["assistant", "cr8or ai"].includes(roles.at(-1)!)) return false;
  const request = turns.at(-2) ?? "";
  const proposal = turns.at(-1) ?? "";
  return /\b(?:plan|propose|proposal|recommend|outline)\b/i.test(request)
    && /\b(?:code|fix|implementation|changes?|edit)\b/i.test(request)
    && /\b(?:plan|propose|would|will|pending|recommend)\b/i.test(proposal)
    && /\b(?:update|edit|modify|remove|replace|add|fix|change)\b/i.test(proposal)
    && /\b[\w./-]+\.(?:tsx?|jsx?|py|go|rs|java|cs|vue|svelte|sql|css|json)\b/i.test(proposal)
    && !/\b(?:already (?:implemented|applied|completed)|implementation (?:is )?complete|changes (?:are )?applied)\b/i.test(proposal);
}

export function isImplementationRequest(message: string, previousContext = ""): boolean {
  const text = message.trim().toLowerCase().replace(/’/g, "'");
  if (isNonMutatingRequest(text)) return false;
  if (isPlanContinuation(text)) return hasPendingImplementationPlan(previousContext);
  if (/^(?:can|could|would) you\b/.test(text) && text.endsWith("?") && !/\b(?:please|now|go ahead)\b/.test(text)) return false;
  if (/\b(?:do not|don't|never)\s+(?:modify|edit|change|write|implement|fix|build)(?:\s+(?:any\s+)?(?:files?|code|anything))?(?:\s+(?:yet|now))?\s*(?:[.!;]|$)/.test(text) || /\b(?:read[- ]only|plan only|just explain|just answer)\b/.test(text)) return false;
  const positive = text.replace(/\b(?:do not|don't|never)\b[^.!;\n]*/g, "");
  const action = /^(?:(?:please|now|then)\s+|(?:can|could|would) you\s+|i (?:want|need) you to\s+)?(?:implement\b|apply (?:the |this )?fix\b|make (?:the |this )change\b|update (?:the |this )?file\b|fix\b|edit\b|modify\b|refactor\b|write\b|change\b|update\b|add\b|remove\b|proceed with implementation\b|go ahead with (?:the )?changes\b)/;
  if (positive.split(/[.!;\n]\s*/).some(clause => action.test(clause.replace(/^approved(?: for tier \d+(?: only)?)?[,.:]?\s*/, "")))) return true;
  return false;
}

export function currentDelegationTurn(prompt: string): { message: string; history: string } {
  if (!prompt.startsWith("Conversation so far:\n")) return { message: prompt, history: "" };
  const index = prompt.lastIndexOf("\nUser: ");
  if (index < 0) return { message: prompt, history: "" };
  return { message: prompt.slice(index + 7).replace(/\nCr8or AI:\s*$/, ""), history: prompt.slice(0, index) };
}
