export function concat (template, submenu, submenuToAdd) {
  submenuToAdd.forEach(sub => {
    let relativeItem = null
    if (sub.position) {
      switch (sub.position) {
      case 'first':
        submenu.unshift(sub)
        break
      case 'last':
        submenu.push(sub)
        break
      case 'before':
        relativeItem = findById(template, sub['relative-id'])
        if (relativeItem) {
          const array = relativeItem.__parent
          const index = array.indexOf(relativeItem)
          array.splice(index, 0, sub)
        }
        break
      case 'after':
        relativeItem = findById(template, sub['relative-id'])
        if (relativeItem) {
          const array = relativeItem.__parent
          const index = array.indexOf(relativeItem)
          array.splice(index + 1, 0, sub)
        }
        break
      default:
        submenu.push(sub)
        break
      }
    } else {
      submenu.push(sub)
    }
  })
}

export function merge (template, item) {
  if (item.id) {
    const matched = findById(template, item.id)
    if (matched) {
      if (item.submenu && Array.isArray(item.submenu)) {
        if (!Array.isArray(matched.submenu)) {
          matched.submenu = []
        }
        concat(template, matched.submenu, item.submenu)
      }
    } else {
      concat(template, template, [item])
    }
  } else {
    template.push(item)
  }
}

function findById (template, id) {
  for (const i in template) {
    const item = template[i]
    if (item.id === id) {
      // Returned item need to have a reference to parent Array (.__parent).
      // This is required to handle `position` and `relative-id`
      item.__parent = template
      return item
    } else if (Array.isArray(item.submenu)) {
      const result = findById(item.submenu, id)
      if (result) {
        return result
      }
    }
  }
  return null
}

export function translateTemplate (template, keystrokesByCommand, i18n) {
  for (const i in template) {
    const item = template[i]
    if (item.command) {
      item.accelerator = acceleratorForCommand(item.command, keystrokesByCommand)
    }

    // If label is specified, label is used as the key of i18n.t(key),
    // which mainly solves the inaccurate translation of item.id.
    if (i18n) {
      if (item.label) {
        item.label = i18n.t(item.label)
      } else if (item.id) {
        item.label = i18n.t(item.id)
      }
    }

    item.click = () => {
      handleCommand(item)
    }

    if (item.submenu) {
      translateTemplate(item.submenu, keystrokesByCommand, i18n)
    }
  }
  return template
}

export function handleCommand (item) {
  handleCommandBefore(item)

  const args = item['command-arg']
    ? [item.command, item['command-arg']]
    : [item.command]

  global.application.sendCommandToAll(...args)

  handleCommandAfter(item)
}

function handleCommandBefore (item) {
  if (!item['command-before']) {
    return
  }
  const [command, ...args] = item['command-before'].split(',')
  global.application.sendCommandToAll(command, ...args)
}

function handleCommandAfter (item) {
  if (!item['command-after']) {
    return
  }
  const [command, ...args] = item['command-after'].split(',')
  global.application.sendCommandToAll(command, ...args)
}

function acceleratorForCommand (command, keystrokesByCommand) {
  const keystroke = keystrokesByCommand[command]
  if (keystroke) {
    let modifiers = keystroke.split(/-(?=.)/)
    const key = modifiers.pop().toUpperCase()
      .replace('+', 'Plus')
      .replace('MINUS', '-')
    modifiers = modifiers.map((modifier) => {
      if (process.platform === 'darwin') {
        return modifier.replace(/cmdctrl/ig, 'Cmd')
          .replace(/shift/ig, 'Shift')
          .replace(/cmd/ig, 'Cmd')
          .replace(/ctrl/ig, 'Ctrl')
          .replace(/alt/ig, 'Alt')
      } else {
        return modifier.replace(/cmdctrl/ig, 'Ctrl')
          .replace(/shift/ig, 'Shift')
          .replace(/ctrl/ig, 'Ctrl')
          .replace(/alt/ig, 'Alt')
      }
    })
    const keys = modifiers.concat([key])
    return keys.join('+')
  }
  return null
}

export function flattenMenuItems (menu) {
  const flattenItems = {}
  menu.items.forEach(item => {
    if (item.id) {
      flattenItems[item.id] = item
      if (item.submenu) {
        Object.assign(flattenItems, flattenMenuItems(item.submenu))
      }
    }
  })
  return flattenItems
}

export function updateStates (itemsById, visibleStates, enabledStates, checkedStates) {
  if (visibleStates) {
    for (const command in visibleStates) {
      const item = itemsById[command]
      if (item) {
        item.visible = visibleStates[command]
      }
    }
  }
  if (enabledStates) {
    for (const command in enabledStates) {
      const item = itemsById[command]
      if (item) {
        item.enabled = enabledStates[command]
      }
    }
  }
  if (checkedStates) {
    for (const id in checkedStates) {
      const item = itemsById[id]
      if (item) {
        item.checked = checkedStates[id]
      }
    }
  }
}
