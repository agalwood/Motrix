const RULE_REGEX = /\(([^)]*)\)/
const PLUS = '+'
const MINUS = '-'
const OPERATORS = [PLUS, MINUS]

export function getRuleString (out) {
  const rule = out.match(RULE_REGEX)
  const result = rule && rule[1]

  return result
}

export function buildRule (rule) {
  let ruleArr
  let operator = PLUS
  let init = 1
  let step = 1
  let len = 1

  OPERATORS.some(OPT => {
    if (rule.includes(OPT)) {
      ruleArr = rule.split(OPT)
      operator = OPT
      return true
    }
  })

  if (ruleArr) {
    len = ruleArr[0].length
    init = parseInt(ruleArr[0], 10)
    step = ruleArr[1] || 1
    if (operator === MINUS) {
      step = -step
    }
  }

  return {
    init,
    step,
    len
  }
}

export function buildOuts (uris = [], out = '') {
  const result = []
  const count = uris.length
  if (count === 0 || !out) {
    return result
  }

  const ruleStr = getRuleString(out)
  if (!ruleStr) {
    return result
  }
  const rule = buildRule(ruleStr)

  let idx
  let temp

  for (let i = 0; i < count; i++) {
    idx = `${rule.init + rule.step * i}`.padStart(rule.len, '0')

    temp = out.replace(RULE_REGEX, idx)

    result.push(temp)
  }

  return result
}
