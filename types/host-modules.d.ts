/**
 * 宿主（DSH）在运行时提供的模块，本地 node_modules 里没有。
 *
 * 这里只声明插件用到的最小形状，**真实类型以宿主为准**——目的是让 `npm run typecheck`
 * 能覆盖插件自己的代码，而不是被"找不到宿主模块"挡住。运行时解析由 DSH 负责。
 */
declare module '@deepseek-ai/cordis' {
  /** 插件上下文：宿主注入的服务、日志、生命周期钩子都挂在这上面。 */
  export interface Context {
    [key: string]: any
  }
}
