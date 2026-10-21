// Буфер обмена. В WebView2 и в браузере на 127.0.0.1 Clipboard API доступен: контекст
// защищённый, а запись идёт по клику пользователя. false — не получилось (нет API или отказ).

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}
