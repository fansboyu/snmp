// Retry the complete implicit transaction, never an individual DDL statement.
export async function databaseStartup(
  work,
  pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await work()
    } catch (error) {
      if (error.code !== '40P01' || attempt >= 3) throw error
      await pause(250 * (attempt + 1))
    }
  }
}
