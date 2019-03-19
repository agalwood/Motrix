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
            let array = relativeItem.__parent
            let index = array.indexOf(relativeItem)
            array.splice(index, 0, sub)
          }
          break
        case 'after':
          relativeItem = findById(template, sub['relative-id'])
          if (relativeItem) {
            let array = relativeItem.__parent
            let index = array.indexOf(relativeItem)
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
    let matched = findById(template, item.id)
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
  for (let i in template) {
    let item = template[i]
    if (item.id === id) {
      // Returned item need to have a reference to parent Array (.__parent).
      // This is required to handle `position` and `relative-id`
      item.__parent = template
      return item
    } else if (Array.isArray(item.submenu)) {
      let result = findById(item.submenu, id)
      if (result) {
        return result
      }
    }
  }
  return null
}

export function translateTemplate (template, keystrokesByCommand) {
  for (let i in template) {
    let item = template[i]
    if (item.command) {
      item.accelerator = acceleratorForCommand(item.command, keystrokesByCommand)
    }
    item.click = () => {
      console.log('click sendCommand', item)
      handleCommand(item)
    }

    if (item.submenu) {
      translateTemplate(item.submenu, keystrokesByCommand)
    }
  }
  return template
}

export function handleCommand (item) {
  handleCommandBefore(item)

  const args = item['command-arg']
    ? [item.command, item['command-arg']]
    : [item.command]

  global.application.sendCommandAll(...args)

  handleCommandAfter(item)
}

function handleCommandBefore (item) {
  console.log('handleCommandBefore==1=>', item)
  if (!item['command-before']) {
    return
  }
  const [ command, ...args ] = item['command-before'].split(',')
  console.log('handleCommandBefore==2=>', command, ...args)
  global.application.sendCommandAll(command, ...args)
}

function handleCommandAfter (item) {
  console.log('handleCommandAfter==1=>', item)
  if (!item['command-after']) {
    return
  }
  const [ command, ...args ] = item['command-after'].split(',')
  console.log('handleCommandAfter==2=>', command, ...args)
  global.application.sendCommandAll(command, ...args)
}

function acceleratorForCommand (command, keystrokesByCommand) {
  const keystroke = keystrokesByCommand[command]
  if (keystroke) {
    let modifiers = keystroke.split(/-(?=.)/)
    let key = modifiers.pop().toUpperCase()
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
    let keys = modifiers.concat([key])
    return keys.join('+')
  }
  return null
}

export function flattenMenuItems (menu) {
  let flattenItems = {}
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
    for (let command in visibleStates) {
      let item = itemsById[command]
      if (item) {
        item.visible = visibleStates[command]
      }
    }
  }
  if (enabledStates) {
    for (let command in enabledStates) {
      let item = itemsById[command]
      if (item) {
        item.enabled = enabledStates[command]
      }
    }
  }
  if (checkedStates) {
    for (let id in checkedStates) {
      let item = itemsById[id]
      if (item) {
        item.checked = checkedStates[id]
      }
    }
  }
}
