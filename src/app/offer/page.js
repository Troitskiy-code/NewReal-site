import Footer from "@/components/Footer";
import Link from "next/link";

export const metadata = {
  title: "Публичная оферта — NewVerse",
  description: "Публичная оферта на оказание услуг сервиса NewVerse.",
};

export default function OfferPage() {
  return (
    <div className="flex min-h-dvh flex-col bg-wd-bg text-wd-text">
      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-12 sm:px-6 lg:px-8">
        <h1 className="mb-8 text-3xl font-black uppercase tracking-tight text-white">
          Публичная оферта NewVerse
        </h1>
        <p className="mb-8 text-sm text-wd-text-secondary">
          Настоящий документ является публичной офертой в соответствии со ст. 437 ГК РФ.
        </p>

        <div className="space-y-8 text-sm leading-relaxed text-wd-text-secondary">
          <section className="space-y-3">
            <h2 className="text-lg font-bold text-white">1. Общие положения</h2>
            <p>
              Индивидуальный предприниматель (самозанятый) Троицкий Артемий Сергеевич, ИНН
              525914183000, предлагает неограниченному кругу лиц (далее – Пользователи) заключить
              договор на оказание услуг по предоставлению доступа к сервису NewVerse (далее –
              Сервис) на условиях настоящей оферты.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-bold text-white">2. Описание услуг</h2>
            <p>Сервис предоставляет Пользователям доступ к:</p>
            <ul className="list-disc space-y-2 pl-5">
              <li>Общению с ИИ-персонажами в ролевых играх.</li>
              <li>Созданию и редактированию персонажей.</li>
              <li>Виртуальной валюте Verse Coins (VC) для оплаты запросов к ИИ.</li>
              <li>
                Подпискам «Диалог», «История», «Вселенная» с расширенными возможностями
                (повышенный контекст, приоритетная обработка).
              </li>
            </ul>
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-bold text-white">3. Стоимость услуг и порядок оплаты</h2>
            <p>
              Цены на пакеты VC и подписки указаны на страницах{" "}
              <Link href="/coins" className="text-wd-secondary underline hover:text-white">
                /coins
              </Link>{" "}
              и{" "}
              <Link href="/pricing" className="text-wd-secondary underline hover:text-white">
                /pricing
              </Link>
              .
            </p>
            <p>
              Оплата производится через платёжный сервис Robokassa. После успешной оплаты VC
              зачисляются на баланс пользователя в течение нескольких минут. Подписка активируется
              автоматически.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-bold text-white">4. Порядок отказа от услуг и возврата средств</h2>
            <p>
              Пользователь вправе отказаться от услуг и потребовать возврат средств в следующих
              случаях:
            </p>
            <ul className="list-disc space-y-2 pl-5">
              <li>Двойное списание средств за одну покупку.</li>
              <li>
                Техническая ошибка, из-за которой услуга не была оказана (VC не зачислены,
                подписка не активирована).
              </li>
              <li>
                Отказ от подписки в течение 14 дней с момента покупки при условии, что услуга не
                была использована (не было отправлено ни одного запроса к ИИ).
              </li>
            </ul>
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
                </a>
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
            <p>
              Срок рассмотрения заявления – 10 рабочих дней. Возврат осуществляется на ту же карту
              или счёт, с которого был произведён платёж, в течение 5 рабочих дней после принятия
              решения.
            </p>
            <p>
              <span className="text-red-400">Важно:</span> возврат производится в полном объёме,
              без удержания комиссии платёжного сервиса.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-bold text-white">5. Контактная информация и реквизиты</h2>
            <p>
              <strong className="text-white">Исполнитель:</strong> Троицкий Артемий Сергеевич
              (самозанятый)
              <br />
              <strong className="text-white">ИНН:</strong> 525914183000
              <br />
              <strong className="text-white">E-mail:</strong>{" "}
              <a
                href="mailto:mrcheleng87@gmail.com"
                className="text-wd-secondary underline hover:text-white"
              >
                mrcheleng87@gmail.com
              </a>
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-bold text-white">6. Политика обработки персональных данных</h2>
            <p>
              Регистрируясь на сайте, Пользователь даёт согласие на обработку своих персональных
              данных (email, имя, IP-адрес) для целей предоставления услуг сервиса, а также для
              информирования о новостях и акциях (с возможностью отказа от рассылки). Данные не
              передаются третьим лицам, за исключением случаев, предусмотренных законодательством
              РФ.
            </p>
            <p className="text-xs text-wd-text-secondary/80">
              Дата публикации: {new Date().toLocaleDateString("ru-RU")}
            </p>
          </section>
        </div>
      </main>
      <Footer />
    </div>
  );
}
