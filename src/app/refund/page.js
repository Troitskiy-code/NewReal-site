import Footer from "@/components/Footer";
import Link from "next/link";

export const metadata = {
  title: "Политика возврата средств — NewVerse",
  description: "Условия возврата денежных средств в сервисе NewVerse.",
};

export default function RefundPage() {
  return (
    <div className="flex min-h-dvh flex-col bg-wd-bg text-wd-text">
      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-12 sm:px-6 lg:px-8">
        <h1 className="mb-8 text-3xl font-black uppercase tracking-tight text-white">
          Политика возврата средств NewVerse
        </h1>

        <div className="space-y-8 text-sm leading-relaxed text-wd-text-secondary">
          <section className="space-y-3">
            <h2 className="text-lg font-bold text-white">1. Предмет услуги</h2>
            <p>
              NewVerse предоставляет доступ к цифровым услугам: общению с ИИ-персонажами,
              использованию виртуальной валюты VerseCoins (VC) и платным подпискам, расширяющим
              функциональность сервиса. Оплата осуществляется через платёжную систему Unitpay.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-bold text-white">2. Когда возможен возврат</h2>
            <p>Возврат денежных средств может быть рассмотрен в следующих случаях:</p>
            <ul className="list-disc space-y-2 pl-5">
              <li>двойное списание средств за один и тот же платёж;</li>
              <li>
                техническая ошибка на стороне сервиса или платёжной системы, из-за которой оплаченная
                услуга не была оказана (VC не зачислены, подписка не активирована);
              </li>
              <li>иные обоснованные случаи — по усмотрению Администрации сервиса.</li>
            </ul>
            <p>
              VC, уже использованные для запросов к ИИ, как правило, не подлежат возврату, так как
              услуга считается оказанной в момент списания.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-bold text-white">3. Порядок подачи обращения</h2>
            <p>
              Для подачи жалобы или запроса на возврат направьте письмо на{" "}
              <a href="mailto:support@newvers.ai" className="text-wd-secondary underline hover:text-white">
                support@newvers.ai
              </a>{" "}
              с темой «Запрос на возврат» и укажите:
            </p>
            <ul className="list-disc space-y-2 pl-5">
              <li>email аккаунта в NewVerse;</li>
              <li>дату и сумму платежа;</li>
              <li>идентификатор платежа (если есть);</li>
              <li>описание проблемы и приложенные подтверждающие материалы (скриншоты, чеки).</li>
            </ul>
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-bold text-white">4. Срок рассмотрения</h2>
            <p>
              Обращения рассматриваются в течение <strong className="text-white">10 рабочих дней</strong>{" "}
              с момента получения полного комплекта информации. О результатах рассмотрения мы
              сообщим на указанный вами email.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-bold text-white">5. Контакты</h2>
            <p>
              Email для обращений:{" "}
              <a href="mailto:support@newvers.ai" className="text-wd-secondary underline hover:text-white">
                support@newvers.ai
              </a>
            </p>
            <p>
              Также см.{" "}
              <Link href="/terms" className="text-wd-secondary underline hover:text-white">
                Пользовательское соглашение
              </Link>
              .
            </p>
            <p className="text-xs text-wd-text-secondary/80">
              Дата последнего обновления: {new Date().toLocaleDateString("ru-RU")}
            </p>
          </section>
        </div>
      </main>

      <Footer />
    </div>
  );
}
