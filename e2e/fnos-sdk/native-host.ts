// The real SDK negotiates a Penpal connection with its iframe parent.
const calls: string[] = []
const config = {
  theme: 'light',
  language: 'en-US',
  systemVersion: '1.2.0401',
  format: {},
}
Object.assign(window, {
  hostCalls: calls,
  hostConfig: config,
  hostEmit: (event: string, value: string) =>
    frame.contentWindow?.postMessage(
      {
        penpal: 'call',
        id: 'host-event',
        methodName: '$emit',
        args: [event, value],
      },
      location.origin
    ),
})
window.addEventListener('message', (event) => {
  if (event.origin !== location.origin || event.source !== frame.contentWindow)
    return
  const data = event.data
  if (data?.penpal === 'syn') {
    frame.contentWindow?.postMessage(
      {
        penpal: 'synAck',
        id: 'motrix-test-host',
        appName: 'motrix',
        config: {
          appName: 'motrix',
          os: {
            theme: 'light',
            language: 'en-US',
            version: '1.2.0401',
            format: { date: {} },
          },
        },
        methodNames: [
          'getPlatformConfig',
          'pickSharedFile',
          'openFile',
          'openFileManager',
          'bus.$on',
          'bus.$off',
        ],
      },
      location.origin
    )
  } else if (data?.penpal === 'call') {
    calls.push(data.methodName)
    const returnValue =
      data.methodName === 'getPlatformConfig'
        ? config
        : data.methodName === 'pickSharedFile'
          ? { code: 0, msg: '', data: ['/volume/native'] }
          : undefined
    frame.contentWindow?.postMessage(
      { penpal: 'reply', id: data.id, resolution: 'fulfilled', returnValue },
      location.origin
    )
  }
})
const frame = document.createElement('iframe')
frame.src = '/'
frame.title = 'Motrix'
document.body.append(frame)
