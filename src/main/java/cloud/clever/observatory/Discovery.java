package cloud.clever.observatory;

import com.fasterxml.jackson.annotation.JsonSubTypes;
import com.fasterxml.jackson.annotation.JsonTypeInfo;
import jakarta.validation.constraints.DecimalMax;
import jakarta.validation.constraints.DecimalMin;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Past;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Positive;
import jakarta.validation.constraints.Size;
import java.time.LocalDate;
import java.time.ZoneOffset;
import java.util.Date;
import java.util.List;
import org.bson.Document;

/**
 * A visitor's discovery. Each type has its own fields and its own rules: the JSON body
 * is mapped to one of these records by its "type", then validated server-side before
 * it becomes a MongoDB document with its own shape.
 */
@JsonTypeInfo(use = JsonTypeInfo.Id.NAME, property = "type")
@JsonSubTypes({
    @JsonSubTypes.Type(value = Discovery.Star.class, name = "star"),
    @JsonSubTypes.Type(value = Discovery.Planet.class, name = "planet"),
    @JsonSubTypes.Type(value = Discovery.Comet.class, name = "comet"),
    @JsonSubTypes.Type(value = Discovery.Nebula.class, name = "nebula")
})
public sealed interface Discovery {

    String NAME = "[\\p{L}\\p{N}][\\p{L}\\p{N} .,'’()+/-]{1,39}";
    String NAME_HINT = "2 to 40 letters, digits, spaces or . , ' ( ) + / -";
    String OBSERVER = "[\\p{L}\\p{N} .'’-]{0,30}";

    /** The document exactly as it will be inserted. */
    Document toDocument();

    record Star(
            @NotBlank @Pattern(regexp = NAME, message = NAME_HINT) String name,
            @NotNull @DecimalMin("-1.5") @DecimalMax("15") Double magnitude,
            @NotBlank @Pattern(regexp = "[OBAFGKM][0-9](\\.[0-9])? ?(0|Ia|Iab|Ib|II|III|IV|V)?",
                    message = "use a spectral class such as G2 V, M1 Iab or B8") String spectralClass,
            @NotNull @Positive @DecimalMax("100000") Double distanceLy,
            @NotNull @DecimalMin("0") @DecimalMax("24") Double ra,
            @NotNull @DecimalMin("-90") @DecimalMax("90") Double dec,
            @Pattern(regexp = OBSERVER, message = "up to 30 letters") String observer) implements Discovery {

        public Document toDocument() {
            return new Document("type", "star")
                    .append("name", name.strip())
                    .append("magnitude", magnitude)
                    .append("spectralClass", spectralClass)
                    .append("distanceLy", distanceLy)
                    .append("ra", ra)
                    .append("dec", dec)
                    .append("discovery", stamp(observer));
        }
    }

    record Planet(
            @NotBlank @Pattern(regexp = NAME, message = NAME_HINT) String name,
            @NotNull @Size(max = 12, message = "12 moons at most")
                    List<@Pattern(regexp = NAME, message = "each moon needs " + NAME_HINT) String> moons,
            Boolean rings,
            @NotNull @DecimalMin("0") @DecimalMax("24") Double ra,
            @NotNull @DecimalMin("-90") @DecimalMax("90") Double dec,
            @Pattern(regexp = OBSERVER, message = "up to 30 letters") String observer) implements Discovery {

        public Document toDocument() {
            Document doc = new Document("type", "planet")
                    .append("name", name.strip())
                    .append("moons", moons.stream().map(moon -> new Document("name", moon.strip())).toList());
            if (Boolean.TRUE.equals(rings)) {
                doc.append("rings", true);
            }
            return doc.append("ra", ra).append("dec", dec).append("discovery", stamp(observer));
        }
    }

    record Comet(
            @NotBlank @Pattern(regexp = NAME, message = NAME_HINT) String name,
            @NotNull @Positive @DecimalMax("10000") Double orbitalPeriodYears,
            @NotNull @Past(message = "must be a date in the past") LocalDate lastPerihelion,
            @Pattern(regexp = OBSERVER, message = "up to 30 letters") String observer) implements Discovery {

        public Document toDocument() {
            return new Document("type", "comet")
                    .append("name", name.strip())
                    .append("orbitalPeriodYears", orbitalPeriodYears)
                    .append("lastPerihelion", Date.from(lastPerihelion.atStartOfDay(ZoneOffset.UTC).toInstant()))
                    .append("discovery", stamp(observer));
        }
    }

    record Nebula(
            @NotBlank @Pattern(regexp = NAME, message = NAME_HINT) String name,
            @NotBlank @Pattern(regexp = "emission|reflection|planetary|dark|supernova remnant",
                    message = "choose emission, reflection, planetary, dark or supernova remnant") String nebulaType,
            @NotNull @DecimalMin("0") @DecimalMax("24") Double ra,
            @NotNull @DecimalMin("-90") @DecimalMax("90") Double dec,
            @Pattern(regexp = OBSERVER, message = "up to 30 letters") String observer) implements Discovery {

        /** Nebulae keep the Messier catalogue's nested, sexagesimal coordinates. */
        public Document toDocument() {
            int raTenths = (int) Math.round(ra * 600) % (24 * 600);   // tenths of a minute of time
            int decMinutes = (int) Math.round(Math.abs(dec) * 60);   // minutes of arc
            double degrees = Math.copySign(decMinutes / 60, dec);    // keeps -0.0 for -0°30′
            Document coordinates = new Document("ra", new Document("h", raTenths / 600).append("m", (raTenths % 600) / 10.0))
                    .append("dec", new Document("d", degrees).append("m", decMinutes % 60));
            return new Document("type", "nebula")
                    .append("name", name.strip())
                    .append("nebulaType", nebulaType)
                    .append("coordinates", coordinates)
                    .append("discovery", stamp(observer));
        }
    }

    private static Document stamp(String observer) {
        String by = observer == null || observer.isBlank() ? "an anonymous visitor" : observer.strip();
        return new Document("by", by).append("at", new Date());
    }
}
