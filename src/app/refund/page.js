import Footer from "@/components/Footer";
import Link from "next/link";
import { getLocalizedPageMetadata } from "@/lib/seo";

export async function generateMetadata() {
  return getLocalizedPageMetadata("refund");
}

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
              функциональность сервиса. Оплата осуществляется через платёжный сервис Robokassa.
            </p>
            <p>
              Полные условия оказания услуг содержатся в{" "}
              <Link href="/offer" className="text-wd-secondary underline hover:text-white">
                публичной оферте
              </Link>
              .
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-bold text-white">2. Когда возможен возврат</h2>
            <p>
              Пользователь вправе отказаться от услуг и потребовать возврат средств в следующих
              случаях:
            </p>
            <ul className="list-disc space-y-2 pl-5">
              <li>Двойное списание средств за одну покупку.</li>
              <li>
                Техническая ошибка, из-за которой услуга не была оказана (VC не зачислены, подписка
                не активирована).
              </li>
              <li>
                Отказ от подписки в течение 14 дней с момента покупки при условии, что услуга не
                была использована (не было отправлено ни одного запроса к ИИ).
              </li>
            </ul>
            <p>
              VC, уже использованные для запросов к ИИ, как правило, не подлежат возврату, так как
              услуга считается оказанной в момент списания.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-bold text-white">3. Порядок подачи обращения</h2>
            <p>
              <strong className="text-white">Для возврата средств необходимо:</strong>
            </p>
            <ol className="list-decimal space-y-2 pl-5">
              <li>
                Направить письменное заявление на электронную почту{" "}
                <a
                  href="mailto:mrcheleng87@gmail.com"
                  className="text-wd-secondary underline hover:text-white"
                >
                  mrcheleng87@gmail.com
                </a>{" "}
                или через{" "}
                <Link href="/support" className="text-wd-secondary underline hover:text-white">
                  страницу поддержки
                </Link>
                .
              </li>
              <li>
                В заявлении указать: ФИО, email пользователя, дату и сумму платежа, причину
                возврата.
              </li>
              <li>
                Приложить подтверждение платежа (скриншот или номер транзакции из Robokassa).
              </li>
            </ol>
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-bold text-white">4. Срок рассмотрения и возврата</h2>
            <p>
              Срок рассмотрения заявления –{" "}
              <strong className="text-white">10 рабочих дней</strong>. Возврат осуществляется на ту
              же карту или счёт, с которого был произведён платёж, в течение 5 рабочих дней после
              принятия решения.
            </p>
            <p>
              <span className="text-red-400">Важно:</span> возврат производится в полном объёме,
              без удержания комиссии платёжного сервиса.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-bold text-white">5. Контакты</h2>
            <p>
              Обращения принимаются на{" "}
              <a
                href="mailto:mrcheleng87@gmail.com"
                className="text-wd-secondary underline hover:text-white"
              >
                mrcheleng87@gmail.com
              </a>{" "}
              и через{" "}
              <Link href="/support" className="text-wd-secondary underline hover:text-white">
                страницу поддержки
              </Link>
              .
            </p>
            <p>
              Также см.{" "}
              <Link href="/offer" className="text-wd-secondary underline hover:text-white">
                Публичную оферту
              </Link>{" "}
              и{" "}
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
