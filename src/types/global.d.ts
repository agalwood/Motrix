declare const appId: string
declare const __static: string

declare module '*.vue' {
  import Vue from 'vue'
  export default Vue
}

declare module '*.worker' {
  const WorkerConstructor: {
    new (): Worker
  }
  export default WorkerConstructor
}

declare module 'vue/types/vue' {
  interface Vue {
    $http: import('axios').AxiosStatic
  }

  interface VueConstructor {
    http: import('axios').AxiosStatic
  }
}

declare namespace NodeJS {
  interface Global {
    __static: string
    application: any
    app: any
    launcher: any
  }
}
